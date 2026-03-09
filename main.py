import os
import re
import json
import secrets
import hmac
import hashlib
import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
import httpx
from duckduckgo_search import DDGS

# Module-level compiled regex constants (avoid recompilation per request)
_DATE_PATTERN = re.compile(r"\d{2}\.\d{2}\.\d{4}\s*\|\s*\d{2}:\d{2}:\d{2}")
_META_PATTERN = re.compile(
    r"^(\w+)(?:\t|\s{2,})(\d{2}\.\d{2}\.\d{4})\s*\|\s*(\d{2}:\d{2}:\d{2})(?:\t|\s{2,})(.+?)(?:\t.*)?$"
)
_SORT_TYPE_RE = re.compile(r'\[\s*(\d)')
_OCPP_PATTERN = re.compile(r"(\[\s*(?:2|3|4)\s*,\s*\"[^\"]*\".*\])")
_TS_PATTERN   = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?)\s*")
_DIR_PATTERN  = re.compile(r"\b(SEND|RECV|->|<-)\b", re.IGNORECASE)
_USERNAME_RE  = re.compile(r'^[a-zA-Z0-9_-]{3,32}$')

# OCPP 1.6 spec: actions initiated by the Charging Station → direction SEND
_CS_INITIATED_ACTIONS = frozenset({
    "Authorize", "BootNotification", "DataTransfer",
    "DiagnosticsStatusNotification", "FirmwareStatusNotification",
    "Heartbeat", "MeterValues", "StartTransaction", "StatusNotification",
    "StopTransaction",
})

# OCPP 1.6 spec: actions initiated by the Central System/Backend → direction RECV
_BACKEND_INITIATED_ACTIONS = frozenset({
    "CancelReservation", "ChangeAvailability", "ChangeConfiguration",
    "ClearCache", "ClearChargingProfile", "GetCompositeSchedule",
    "GetConfiguration", "GetDiagnostics", "GetLocalListVersion",
    "RemoteStartTransaction", "RemoteStopTransaction", "ReserveNow",
    "Reset", "SendLocalList", "SetChargingProfile", "TriggerMessage",
    "UnlockConnector", "UpdateFirmware",
})

# ── Data layer ────────────────────────────────────────────────
# /tmp is writable on both Vercel serverless and Docker containers.
# For Docker with persistent storage mount ./data:/tmp/ocpp-data.
DATA_DIR      = Path(os.getenv("DATA_DIR", "/tmp/ocpp-data"))
USERS_FILE    = DATA_DIR / "users.json"
SETTINGS_FILE = DATA_DIR / "settings.json"

SESSION_TTL_HOURS = 8
# Stateless signed tokens – work across serverless instances, no shared state needed.
_SECRET = os.getenv("SESSION_SECRET", secrets.token_hex(32)).encode()

_PBKDF2_ITERATIONS = 260_000


def _hash_password(password: str) -> str:
    """PBKDF2-SHA256 with random salt. Pure stdlib, no native extensions."""
    salt = os.urandom(32)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
    return salt.hex() + ":" + key.hex()


def _verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, key_hex = stored.split(":", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(key_hex)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ITERATIONS)
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False

MSG_TYPES = {2: "CALL", 3: "CALLRESULT", 4: "CALLERROR"}

_DEFAULT_SETTINGS = {
    "ollama_url": "http://localhost:11434",
    "default_model": "",
    "analyze_prompt": "",
    "explain_prompt": "",
}


def _initialize_data():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not USERS_FILE.exists():
        username = os.getenv("OCPP_USERNAME", "admin")
        password = os.getenv("OCPP_PASSWORD", "changeme")
        users_data = {"users": [{
            "username": username,
            "password_hash": _hash_password(password),
            "role": "admin",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": "system",
        }]}
        USERS_FILE.write_text(json.dumps(users_data, indent=2, ensure_ascii=False))
        print(f"[startup] Admin user '{username}' created from env vars. "
              "OCPP_USERNAME/OCPP_PASSWORD are no longer used after first boot.")
    if not SETTINGS_FILE.exists():
        SETTINGS_FILE.write_text(json.dumps(_DEFAULT_SETTINGS, indent=2, ensure_ascii=False))


def _load_users() -> list[dict]:
    return json.loads(USERS_FILE.read_text()).get("users", [])


def _save_users(users: list[dict]):
    USERS_FILE.write_text(json.dumps({"users": users}, indent=2, ensure_ascii=False))


def _load_settings() -> dict:
    data = json.loads(SETTINGS_FILE.read_text())
    # Ensure all default keys exist
    return {**_DEFAULT_SETTINGS, **data}


def _save_settings(settings: dict):
    SETTINGS_FILE.write_text(json.dumps(settings, indent=2, ensure_ascii=False))


# ── Stateless signed session tokens ──────────────────────────
def _make_token(username: str, role: str) -> str:
    """Create a signed session token: base64(payload).signature"""
    exp = int((datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS)).timestamp())
    payload = base64.urlsafe_b64encode(
        json.dumps({"u": username, "r": role, "exp": exp}).encode()
    ).decode()
    sig = hmac.new(_SECRET, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def _verify_token(token: str) -> dict | None:
    """Verify token signature and expiry. Returns payload dict or None."""
    try:
        payload_b64, sig = token.rsplit(".", 1)
    except ValueError:
        return None
    expected = hmac.new(_SECRET, payload_b64.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
    except Exception:
        return None
    if data.get("exp", 0) < datetime.now(timezone.utc).timestamp():
        return None
    return data


# ── Auth dependencies ─────────────────────────────────────────
def get_current_user(request: Request) -> dict:
    token = request.cookies.get("session")
    if not token:
        raise HTTPException(status_code=401, detail="Nicht angemeldet")
    data = _verify_token(token)
    if not data:
        raise HTTPException(status_code=401, detail="Sitzung abgelaufen")
    return {"username": data["u"], "role": data["r"]}


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Nur für Administratoren")
    return user


# ── Pydantic models ───────────────────────────────────────────
class LoginRequest(BaseModel):
    username: str
    password: str


class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str = "user"


class UpdateSettingsRequest(BaseModel):
    ollama_url: Optional[str] = None
    default_model: Optional[str] = None
    analyze_prompt: Optional[str] = None
    explain_prompt: Optional[str] = None


class ParseRequest(BaseModel):
    log_content: str = Field(..., max_length=50_000_000)


class AnalyzeRequest(BaseModel):
    log_content: str
    parsed_data: dict
    ollama_url: str
    model: str
    customer_context: str = ""
    system_prompt: str | None = None


# ── App factory ───────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    _initialize_data()
    yield


app = FastAPI(title="OCPP Log Analyzer", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")


# ── OCPP parsing helpers ──────────────────────────────────────
def _table_sort_key(line: str) -> tuple:
    parts = line.split(' ', 1)
    ts = parts[0] if parts else ''
    mtype = 9
    m = _SORT_TYPE_RE.search(line)
    if m:
        mtype = int(m.group(1))
    return (ts, mtype)


def is_table_format(log_content: str) -> bool:
    for line in log_content.split("\n")[:100]:
        if _DATE_PATTERN.search(line):
            return True
    return False


def preprocess_table_format(log_content: str) -> str:
    lines = log_content.split("\n")
    result = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        match = _META_PATTERN.match(stripped)
        if match:
            date_str = match.group(2)
            time_str = match.group(3)
            day, month, year = date_str.split(".")
            iso_ts = f"{year}-{month}-{day}T{time_str}.000Z"
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and lines[j].strip().startswith("["):
                result.append(f"{iso_ts} {lines[j].strip()}")
                i = j + 1
                continue
        if stripped.startswith("[") and _OCPP_PATTERN.search(stripped):
            result.append(stripped)
            i += 1
            continue
        i += 1
    result.sort(key=_table_sort_key)
    return "\n".join(result)


def parse_ocpp_logs(log_content: str) -> dict:
    if is_table_format(log_content):
        log_content = preprocess_table_format(log_content)

    messages = []
    errors = []
    warnings = []
    lines = log_content.split("\n")
    call_map = {}
    pending_results = {}
    has_boot_notification = False

    for line_num, line in enumerate(lines, 1):
        if not line.strip():
            continue
        timestamp = None
        ts_match = _TS_PATTERN.match(line.strip())
        if ts_match:
            timestamp = ts_match.group(1)
        direction = None
        dir_match = _DIR_PATTERN.search(line)
        if dir_match:
            d = dir_match.group(1).upper()
            direction = "SEND" if d in ("SEND", "->") else "RECV"
        ocpp_match = _OCPP_PATTERN.search(line)
        if not ocpp_match:
            continue
        try:
            msg_json = json.loads(ocpp_match.group(1))
        except json.JSONDecodeError:
            continue
        if not isinstance(msg_json, list) or len(msg_json) < 2:
            continue
        msg_type_id = msg_json[0]
        if msg_type_id not in MSG_TYPES:
            continue
        msg_type = MSG_TYPES[msg_type_id]
        unique_id = msg_json[1]
        msg = {
            "line": line_num,
            "type": msg_type,
            "typeId": msg_type_id,
            "uniqueId": unique_id,
            "timestamp": timestamp,
            "direction": direction,
            "raw": ocpp_match.group(1),
        }
        if msg_type == "CALL" and len(msg_json) >= 3:
            action = msg_json[2]
            payload = msg_json[3] if len(msg_json) > 3 else {}
            msg["action"] = action
            msg["payload"] = payload
            if direction is None:
                if action in _CS_INITIATED_ACTIONS:
                    direction = "SEND"
                elif action in _BACKEND_INITIATED_ACTIONS:
                    direction = "RECV"
            msg["direction"] = direction
            call_map[unique_id] = msg
            if action == "BootNotification":
                has_boot_notification = True
            if unique_id in pending_results:
                result_msg = pending_results.pop(unique_id)
                result_msg["action"] = action
                msg["answered"] = True
                result_payload = result_msg.get("payload", {})
                if isinstance(result_payload, dict):
                    r_status = result_payload.get("status", "")
                    if r_status in ("Rejected", "Faulted", "Invalid"):
                        errors.append({
                            "line": result_msg["line"],
                            "type": "error",
                            "message": f"CALLRESULT status '{r_status}' für {action}",
                            "detail": json.dumps(result_payload, ensure_ascii=False),
                        })
                    if action == "StatusNotification":
                        error_code = payload.get("errorCode", "NoError")
                        connector_status = payload.get("status", "")
                        if error_code != "NoError":
                            errors.append({
                                "line": line_num,
                                "type": "error",
                                "message": f"StatusNotification errorCode: '{error_code}' (Status: {connector_status})",
                                "detail": json.dumps(payload, ensure_ascii=False),
                            })
                        elif connector_status == "Faulted":
                            errors.append({
                                "line": line_num,
                                "type": "error",
                                "message": "StatusNotification: Ladestation meldet 'Faulted'",
                                "detail": json.dumps(payload, ensure_ascii=False),
                            })
        elif msg_type == "CALLRESULT":
            payload = msg_json[2] if len(msg_json) > 2 else {}
            msg["payload"] = payload
            if unique_id in call_map:
                original_call = call_map[unique_id]
                msg["action"] = original_call.get("action", "Unknown")
                original_call["answered"] = True
                if direction is None:
                    call_dir = original_call.get("direction")
                    if call_dir == "SEND":
                        direction = "RECV"
                    elif call_dir == "RECV":
                        direction = "SEND"
                msg["direction"] = direction
                if isinstance(payload, dict):
                    status = payload.get("status", "")
                    if status in ("Rejected", "Faulted", "Invalid"):
                        errors.append({
                            "line": line_num,
                            "type": "error",
                            "message": f"CALLRESULT status '{status}' für {msg['action']}",
                            "detail": json.dumps(payload, ensure_ascii=False),
                        })
                    if original_call.get("action") == "StatusNotification":
                        call_payload = original_call.get("payload", {})
                        error_code = call_payload.get("errorCode", "NoError")
                        connector_status = call_payload.get("status", "")
                        if error_code != "NoError":
                            errors.append({
                                "line": original_call["line"],
                                "type": "error",
                                "message": f"StatusNotification errorCode: '{error_code}' (Status: {connector_status})",
                                "detail": json.dumps(call_payload, ensure_ascii=False),
                            })
                        elif connector_status == "Faulted":
                            errors.append({
                                "line": original_call["line"],
                                "type": "error",
                                "message": "StatusNotification: Ladestation meldet 'Faulted'",
                                "detail": json.dumps(call_payload, ensure_ascii=False),
                            })
            else:
                pending_results[unique_id] = msg
        elif msg_type == "CALLERROR":
            error_code = msg_json[2] if len(msg_json) > 2 else "Unknown"
            error_desc = msg_json[3] if len(msg_json) > 3 else ""
            error_details = msg_json[4] if len(msg_json) > 4 else {}
            msg["errorCode"] = error_code
            msg["errorDescription"] = error_desc
            msg["errorDetails"] = error_details
            action = "Unknown"
            if unique_id in call_map:
                action = call_map[unique_id].get("action", "Unknown")
                call_map[unique_id]["answered"] = True
                if direction is None:
                    call_dir = call_map[unique_id].get("direction")
                    if call_dir == "SEND":
                        direction = "RECV"
                    elif call_dir == "RECV":
                        direction = "SEND"
            msg["action"] = action
            msg["direction"] = direction
            errors.append({
                "line": line_num,
                "type": "error",
                "message": f"CALLERROR: {error_code} – {error_desc} (Aktion: {action})",
                "detail": json.dumps(error_details, ensure_ascii=False),
            })
        messages.append(msg)

    for uid, call_msg in call_map.items():
        if not call_msg.get("answered"):
            action = call_msg.get("action", uid)
            warnings.append({
                "line": call_msg["line"],
                "type": "warning",
                "message": f"Unbeantworteter CALL: {action} (UniqueId: {uid})",
                "detail": call_msg.get("raw", ""),
            })

    if not has_boot_notification and messages:
        warnings.append({
            "line": 0,
            "type": "warning",
            "message": "Kein BootNotification im Log gefunden",
            "detail": "Die Ladestation sollte beim Start ein BootNotification senden.",
        })

    stats = {
        "total": len(messages),
        "calls": sum(1 for m in messages if m["type"] == "CALL"),
        "callresults": sum(1 for m in messages if m["type"] == "CALLRESULT"),
        "callerrors": sum(1 for m in messages if m["type"] == "CALLERROR"),
        "errors": len(errors),
        "warnings": len(warnings),
    }
    return {"messages": messages, "errors": errors, "warnings": warnings, "stats": stats}


# ── Auth endpoints ────────────────────────────────────────────
@app.post("/api/auth/login")
async def login(body: LoginRequest, response: Response):
    users = _load_users()
    user = next((u for u in users if u["username"] == body.username), None)
    if not user or not _verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Ungültige Anmeldedaten")
    token = _make_token(user["username"], user["role"])
    response.set_cookie(
        "session", token,
        httponly=True, samesite="lax",
        max_age=SESSION_TTL_HOURS * 3600,
        path="/",
    )
    return {"username": user["username"], "role": user["role"]}


@app.post("/api/auth/logout")
async def logout(request: Request, response: Response):
    token = request.cookies.get("session")
    if token and token in _sessions:
        del _sessions[token]
    response.delete_cookie("session", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


# ── User management ───────────────────────────────────────────
@app.get("/api/users")
async def list_users(_: dict = Depends(require_admin)):
    users = _load_users()
    return {"users": [
        {"username": u["username"], "role": u["role"], "created_at": u.get("created_at", "")}
        for u in users
    ]}


@app.post("/api/users", status_code=201)
async def create_user(body: CreateUserRequest, current: dict = Depends(require_admin)):
    if not _USERNAME_RE.match(body.username):
        raise HTTPException(status_code=400, detail="Ungültiger Benutzername (3–32 Zeichen: a–z, 0–9, - oder _)")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Passwort muss mindestens 8 Zeichen lang sein")
    if body.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Ungültige Rolle (admin oder user)")
    users = _load_users()
    if any(u["username"] == body.username for u in users):
        raise HTTPException(status_code=409, detail="Benutzername bereits vergeben")
    new_user = {
        "username": body.username,
        "password_hash": _hash_password(body.password),
        "role": body.role,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_by": current["username"],
    }
    users.append(new_user)
    _save_users(users)
    return {"username": new_user["username"], "role": new_user["role"], "created_at": new_user["created_at"]}


@app.delete("/api/users/{username}", status_code=204)
async def delete_user(username: str, current: dict = Depends(require_admin)):
    if username == current["username"]:
        raise HTTPException(status_code=400, detail="Der eigene Account kann nicht gelöscht werden")
    users = _load_users()
    new_users = [u for u in users if u["username"] != username]
    if len(new_users) == len(users):
        raise HTTPException(status_code=404, detail="Benutzer nicht gefunden")
    _save_users(new_users)
    # Note: stateless tokens cannot be actively revoked.
    # Deleted users' tokens expire naturally after SESSION_TTL_HOURS.


# ── Settings endpoints ────────────────────────────────────────
@app.get("/api/settings")
async def get_settings(_: dict = Depends(get_current_user)):
    return _load_settings()


@app.put("/api/settings")
async def update_settings(body: UpdateSettingsRequest, _: dict = Depends(require_admin)):
    settings = _load_settings()
    for field in ("ollama_url", "default_model", "analyze_prompt", "explain_prompt"):
        val = getattr(body, field)
        if val is not None:
            settings[field] = val
    _save_settings(settings)
    return settings


# ── Core endpoints ────────────────────────────────────────────
@app.get("/")
async def root():
    return FileResponse("static/index.html")


@app.post("/api/parse")
async def parse_logs(request: ParseRequest, _: dict = Depends(get_current_user)):
    try:
        return parse_ocpp_logs(request.log_content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/models")
async def get_models(ollama_url: str = "", user: dict = Depends(get_current_user)):
    settings = _load_settings()
    # Non-admins always use the server-configured URL
    if user["role"] != "admin" or not ollama_url:
        ollama_url = settings.get("ollama_url", "http://localhost:11434")
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{ollama_url}/api/tags")
            response.raise_for_status()
            data = response.json()
            models = [m["name"] for m in data.get("models", [])]
            return {"models": models}
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Modelle konnten nicht geladen werden: {str(e)}",
        )


@app.post("/api/analyze")
async def analyze_logs(request: AnalyzeRequest, user: dict = Depends(get_current_user)):
    stats = request.parsed_data.get("stats", {})
    errors = request.parsed_data.get("errors", [])
    warnings = request.parsed_data.get("warnings", [])

    # Non-admins use the server-configured ollama_url
    ollama_url = request.ollama_url
    if user["role"] != "admin":
        settings = _load_settings()
        ollama_url = settings.get("ollama_url", ollama_url)

    log_preview = (
        request.log_content[:6000]
        if len(request.log_content) > 6000
        else request.log_content
    )

    if request.customer_context.strip():
        context_directive = (
            f"\n\nWICHTIG – PRIMÄRER FOKUS DER ANALYSE:\n"
            f"Der Kunde meldet folgendes Problem: \"{request.customer_context.strip()}\"\n"
            f"Richte die gesamte Analyse auf die Ursachenfindung für dieses spezifische Problem aus. "
            f"Jeder Abschnitt soll explizit auf diesen Kontext Bezug nehmen, wo relevant."
        )
    else:
        context_directive = ""

    if request.system_prompt and request.system_prompt.strip():
        system_prompt = request.system_prompt.strip() + context_directive
    else:
        system_prompt = f"""Du bist ein OCPP 1.6 Experte und Spezialist für Ladeinfrastruktur-Kommunikation.
Analysiere die bereitgestellten OCPP-Logs und erstelle eine strukturierte Fehlerdiagnose auf Deutsch.{context_directive}

Deine Analyse muss folgende Abschnitte enthalten:
1. **Zusammenfassung** - Kurzer Überblick über den Log-Inhalt und Kommunikationsfluss
2. **Kritische Fehler** - Alle CALLERROR-Nachrichten und schwerwiegenden Probleme mit Ursachenanalyse
3. **Warnungen** - Nicht-kritische Auffälligkeiten und potenzielle Probleme
4. **Protokoll-Compliance** - Einhaltung des OCPP 1.6 Standards (Nachrichtenreihenfolge, Pflichtfelder, etc.)
5. **Lösungsvorschläge** - Konkrete, priorisierte Schritte zur Behebung der gefundenen Fehler
6. **Best Practices** - Empfehlungen für eine robustere OCPP-Implementierung
7. **Prioritätenliste** - Nach Dringlichkeit sortierte Maßnahmenliste (KRITISCH / WICHTIG / OPTIONAL)"""

    if request.customer_context.strip():
        context_block = (
            f"**Kundengemeldetes Problem (höchste Priorität):**\n"
            f"> {request.customer_context.strip()}\n\n"
            f"Füge direkt nach der Zusammenfassung einen Abschnitt "
            f"'**Kontextbezogene Ursachenanalyse**' ein, der erklärt, welche Log-Einträge "
            f"mit dem gemeldeten Problem zusammenhängen und warum.\n\n"
        )
    else:
        context_block = ""

    user_prompt = f"""Analysiere folgendes OCPP 1.6 Kommunikationslog:

{context_block}**Statistiken:**
- Gesamt-Nachrichten: {stats.get('total', 0)}
- CALL: {stats.get('calls', 0)} | CALLRESULT: {stats.get('callresults', 0)} | CALLERROR: {stats.get('callerrors', 0)}
- Erkannte Fehler: {stats.get('errors', 0)} | Warnungen: {stats.get('warnings', 0)}

**Automatisch erkannte Probleme:**
Fehler: {json.dumps(errors, ensure_ascii=False, indent=2) if errors else "Keine"}
Warnungen: {json.dumps(warnings, ensure_ascii=False, indent=2) if warnings else "Keine"}

**Log-Inhalt:**
```
{log_preview}
```

Erstelle eine detaillierte, technisch fundierte Analyse mit konkreten Lösungsvorschlägen."""

    async def stream_response():
        try:
            async with httpx.AsyncClient(timeout=180.0) as client:
                async with client.stream(
                    "POST",
                    f"{ollama_url}/api/generate",
                    json={
                        "model": request.model,
                        "prompt": user_prompt,
                        "system": system_prompt,
                        "stream": True,
                        "options": {"temperature": 0.3, "num_ctx": 8192},
                    },
                ) as response:
                    async for line in response.aiter_lines():
                        if line:
                            try:
                                data = json.loads(line)
                                if "response" in data:
                                    yield data["response"]
                                if data.get("done"):
                                    return
                            except json.JSONDecodeError:
                                continue
        except Exception as e:
            yield f"\n\n**Fehler bei der KI-Analyse:** {str(e)}"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")


@app.get("/api/search-hardware")
async def search_hardware(vendor: str = "", model: str = "", firmware: str = "", _: dict = Depends(get_current_user)):
    parts = [p for p in [vendor, model] if p.strip()]
    if not parts:
        raise HTTPException(status_code=400, detail="Kein Suchbegriff")

    base = " ".join(parts)
    raw = []

    try:
        with DDGS() as ddgs:
            for q in [f"{base} EV charger", f"{base} OCPP charging station"]:
                for r in ddgs.text(q, max_results=5):
                    raw.append({"type": "link", "title": r["title"],
                                "url": r["href"], "snippet": r["body"]})
            for r in ddgs.images(base, max_results=6):
                raw.append({"type": "image", "title": r.get("title", ""),
                            "url": r.get("url", ""), "thumbnail": r.get("thumbnail", ""),
                            "source": r.get("source", "")})
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Suche fehlgeschlagen: {e}")

    seen, unique = set(), []
    for r in raw:
        if r["url"] not in seen:
            seen.add(r["url"])
            unique.append(r)

    return {"results": unique}


@app.post("/api/explain")
async def explain(request: AnalyzeRequest, user: dict = Depends(get_current_user)):
    stats    = request.parsed_data.get("stats", {})
    errors   = request.parsed_data.get("errors", [])
    warnings = request.parsed_data.get("warnings", [])

    # Non-admins use the server-configured ollama_url
    ollama_url = request.ollama_url
    if user["role"] != "admin":
        settings = _load_settings()
        ollama_url = settings.get("ollama_url", ollama_url)

    customer_issue = request.customer_context.strip() or "allgemeine Log-Analyse"

    log_preview = (
        request.log_content[:3000]
        if len(request.log_content) > 3000
        else request.log_content
    )

    context_directive = ""
    if request.customer_context.strip():
        context_directive = (
            f"\n\nPRIMÄRER FOKUS: Deine Erklärung muss direkt und konkret auf das gemeldete Problem "
            f"'{request.customer_context.strip()}' eingehen. "
            f"Beantworte: Bestätigt der Log dieses Problem? Wann genau ist es aufgetreten? Was war die Ursache? "
            f"Alles andere (normale Abläufe etc.) ist nachrangig – das gemeldete Problem steht im Mittelpunkt."
        )

    if request.system_prompt and request.system_prompt.strip():
        system_prompt = request.system_prompt.strip() + context_directive
    else:
        system_prompt = """Du bist ein Assistent für Hotline- und Service-Mitarbeiter im Bereich Elektromobilität.
Deine Aufgabe: Erstelle eine strukturierte, verständliche Erklärung für Service-Mitarbeiter.

Ausgabeformat – verwende Markdown mit exakt diesen Abschnitten (Reihenfolge einhalten):

## Was ist passiert?
Kurze Zusammenfassung der Situation in 2–4 Sätzen. Konkretes Datum und Uhrzeit aus dem Log nennen.

## Erkannte Probleme
Aufzählung der Fehler und Warnungen in Alltagssprache. Falls keine Fehler: kurz beschreiben, dass alles normal aussieht.

## Was bedeutet das für den Nutzer?
Erklärung der Auswirkungen auf den Ladevorgang in einfacher Sprache.

## Nächste Schritte
Konkrete, priorisierte Handlungsempfehlungen um die Ladestation wieder betriebsbereit zu machen. Als nummerierte Liste.

Allgemeine Regeln:
- Schreibe auf Deutsch, sachlich und verständlich
- Keine Fachbegriffe – übersetze OCPP-Konzepte in Alltagssprache
  (z.B. "CALLERROR" → "Fehlermeldung", "BootNotification" → "Einschalten der Ladestation",
   "StatusNotification" → "Statusmeldung", "Heartbeat" → "regelmäßiges Lebenszeichen")
- Verwende NIEMALS relative Zeitangaben – immer das tatsächliche Datum/Uhrzeit aus dem Log
- Kein E-Mail-Format, keine Begrüßung, keine Grußformel""" + context_directive

    user_prompt = f"""Erstelle eine Erklärung für Hotline-/Service-Mitarbeiter zur folgenden Situation:

Gemeldetes Problem: "{customer_issue}"{context_directive}

Was der Analyzer gefunden hat:
- Gesamtnachrichten: {stats.get('total', 0)}
- Fehlermeldungen: {stats.get('errors', 0)}
- Warnungen: {stats.get('warnings', 0)}

Erkannte Fehler (max. 5):
{json.dumps(errors[:5], ensure_ascii=False, indent=2) if errors else "Keine"}

Erkannte Warnungen (max. 3):
{json.dumps(warnings[:3], ensure_ascii=False, indent=2) if warnings else "Keine"}

Log-Ausschnitt (für Zeitbezüge und konkrete Ereignisse):
```
{log_preview}
```

Schreibe jetzt die strukturierte Erklärung mit allen vier Markdown-Abschnitten:"""

    async def stream_response():
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{ollama_url}/api/generate",
                    json={
                        "model": request.model,
                        "prompt": user_prompt,
                        "system": system_prompt,
                        "stream": True,
                        "options": {"temperature": 0.5, "num_ctx": 4096},
                    },
                ) as response:
                    async for line in response.aiter_lines():
                        if line:
                            try:
                                data = json.loads(line)
                                if "response" in data:
                                    yield data["response"]
                                if data.get("done"):
                                    return
                            except json.JSONDecodeError:
                                continue
        except Exception as e:
            yield f"\n\n[Fehler bei der Erklärung: {str(e)}]"

    return StreamingResponse(stream_response(), media_type="text/plain; charset=utf-8")
