import os
import re
import json
import secrets
import hmac
import hashlib
import base64
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from typing import Optional

import aiomysql

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
_USERNAME_RE  = re.compile(r'^[a-zA-Z0-9._@+-]{3,64}$')

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
_DB_HOST = os.getenv("DB_HOST", "localhost")
_DB_PORT = int(os.getenv("DB_PORT", "3306"))
_DB_USER = os.getenv("DB_USER", "root")
_DB_PASS = os.getenv("DB_PASSWORD", "")
_DB_NAME = os.getenv("DB_NAME", "ocpp_analyzer")

_db_pool: aiomysql.Pool | None = None


async def _get_db_pool() -> aiomysql.Pool:
    global _db_pool
    if _db_pool is None:
        _db_pool = await aiomysql.create_pool(
            host=_DB_HOST, port=_DB_PORT,
            user=_DB_USER, password=_DB_PASS, db=_DB_NAME,
            charset="utf8mb4", autocommit=False,
            minsize=1, maxsize=3,
        )
    return _db_pool

SESSION_TTL_HOURS = 8
# Stateless signed tokens – work across serverless instances, no shared state needed.
if "SESSION_SECRET" not in os.environ:
    import warnings
    warnings.warn(
        "SESSION_SECRET not set – a new random key will be generated on every cold start, "
        "invalidating all sessions! Set SESSION_SECRET as an environment variable.",
        stacklevel=1,
    )
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


async def _initialize_db():
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS settings (
                    id INT PRIMARY KEY DEFAULT 1,
                    ollama_url VARCHAR(512) NOT NULL DEFAULT 'http://localhost:11434',
                    default_model VARCHAR(256) NOT NULL DEFAULT '',
                    analyze_prompt MEDIUMTEXT NOT NULL DEFAULT '',
                    explain_prompt MEDIUMTEXT NOT NULL DEFAULT ''
                ) CHARACTER SET utf8mb4
            """)
            await cur.execute("""
                INSERT IGNORE INTO settings (id) VALUES (1)
            """)
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    username VARCHAR(64) PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role VARCHAR(16) NOT NULL DEFAULT 'user',
                    created_at DATETIME(6) NOT NULL,
                    created_by VARCHAR(64) NOT NULL DEFAULT 'system'
                ) CHARACTER SET utf8mb4
            """)
            await cur.execute("SELECT COUNT(*) FROM users")
            (count,) = await cur.fetchone()
            if count == 0:
                username = os.getenv("OCPP_USERNAME", "admin")
                password = os.getenv("OCPP_PASSWORD", "changeme")
                await cur.execute(
                    "INSERT INTO users (username, password_hash, role, created_at, created_by) "
                    "VALUES (%s, %s, 'admin', %s, 'system')",
                    (username, _hash_password(password),
                     datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")),
                )
                print(f"[startup] Admin user '{username}' created from env vars.")
            try:
                await cur.execute("""
                    CREATE TABLE IF NOT EXISTS analyses (
                        id          INT AUTO_INCREMENT PRIMARY KEY,
                        type        VARCHAR(16)   NOT NULL,
                        created_at  DATETIME(6)   NOT NULL,
                        created_by  VARCHAR(64)   NOT NULL,
                        model       VARCHAR(256)  NOT NULL DEFAULT '',
                        title       VARCHAR(256)  NOT NULL DEFAULT '',
                        session_id  VARCHAR(64)   NOT NULL DEFAULT '',
                        customer_context TEXT     NOT NULL DEFAULT '',
                        stats       MEDIUMTEXT    NOT NULL DEFAULT '{}',
                        result_text LONGTEXT      NOT NULL DEFAULT '',
                        log_snippet TEXT          NOT NULL DEFAULT ''
                    ) CHARACTER SET utf8mb4
                """)
                # Migration: add new columns for existing DBs
                for _col, _defn in [
                    ("`title`",      "VARCHAR(256) NOT NULL DEFAULT ''"),
                    ("`session_id`", "VARCHAR(64)  NOT NULL DEFAULT ''"),
                ]:
                    try:
                        await cur.execute(f"ALTER TABLE analyses ADD COLUMN {_col} {_defn}")
                    except Exception:
                        pass  # Column already exists
            except Exception as e:
                print(f"[startup] analyses table setup skipped: {e}")
        await conn.commit()


async def _load_users() -> list[dict]:
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute("SELECT username, password_hash, role, created_at, created_by FROM users")
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def _save_users(users: list[dict]):
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await conn.begin()
            await cur.execute("DELETE FROM users")
            for u in users:
                await cur.execute(
                    "INSERT INTO users (username, password_hash, role, created_at, created_by) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (u["username"], u["password_hash"], u["role"],
                     u.get("created_at", ""), u.get("created_by", "system")),
                )
        await conn.commit()


async def _load_settings() -> dict:
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute("SELECT ollama_url, default_model, analyze_prompt, explain_prompt FROM settings WHERE id=1")
            row = await cur.fetchone()
    return {**_DEFAULT_SETTINGS, **(dict(row) if row else {})}


async def _save_settings(settings: dict):
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE settings SET ollama_url=%s, default_model=%s, analyze_prompt=%s, explain_prompt=%s WHERE id=1",
                (settings.get("ollama_url", ""), settings.get("default_model", ""),
                 settings.get("analyze_prompt", ""), settings.get("explain_prompt", "")),
            )
        await conn.commit()


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


class SaveAnalysisRequest(BaseModel):
    type: str
    model: str
    title: str = ""
    session_id: str = ""
    customer_context: str = ""
    stats: dict
    result_text: str
    log_snippet: str = ""


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
    await _initialize_db()
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
    users = await _load_users()
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
    response.delete_cookie("session", path="/")
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


# ── User management ───────────────────────────────────────────
@app.get("/api/users")
async def list_users(_: dict = Depends(require_admin)):
    users = await _load_users()
    return {"users": [
        {"username": u["username"], "role": u["role"], "created_at": u.get("created_at", "")}
        for u in users
    ]}


@app.post("/api/users", status_code=201)
async def create_user(body: CreateUserRequest, current: dict = Depends(require_admin)):
    if not _USERNAME_RE.match(body.username):
        raise HTTPException(status_code=400, detail="Ungültiger Benutzername (3–64 Zeichen: Buchstaben, Zahlen, @ . _ - +)")
    if len(body.password) < 8:
        raise HTTPException(status_code=400, detail="Passwort muss mindestens 8 Zeichen lang sein")
    if body.role not in ("admin", "user"):
        raise HTTPException(status_code=400, detail="Ungültige Rolle (admin oder user)")
    users = await _load_users()
    if any(u["username"] == body.username for u in users):
        raise HTTPException(status_code=409, detail="Benutzername bereits vergeben")
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO users (username, password_hash, role, created_at, created_by) "
                "VALUES (%s, %s, %s, %s, %s)",
                (body.username, _hash_password(body.password), body.role,
                 created_at, current["username"]),
            )
        await conn.commit()
    return {"username": body.username, "role": body.role, "created_at": created_at}


@app.delete("/api/users/{username}", status_code=204)
async def delete_user(username: str, current: dict = Depends(require_admin)):
    if username == current["username"]:
        raise HTTPException(status_code=400, detail="Der eigene Account kann nicht gelöscht werden")
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM users WHERE username=%s", (username,))
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Benutzer nicht gefunden")
        await conn.commit()
    # Note: stateless tokens cannot be actively revoked.
    # Deleted users' tokens expire naturally after SESSION_TTL_HOURS.


# ── Settings endpoints ────────────────────────────────────────
@app.get("/api/settings")
async def get_settings(_: dict = Depends(get_current_user)):
    return await _load_settings()


@app.put("/api/settings")
async def update_settings(body: UpdateSettingsRequest, _: dict = Depends(require_admin)):
    settings = await _load_settings()
    for field in ("ollama_url", "default_model", "analyze_prompt", "explain_prompt"):
        val = getattr(body, field)
        if val is not None:
            settings[field] = val
    await _save_settings(settings)
    return settings


# ── Analyses history endpoints ────────────────────────────────
@app.post("/api/analyses", status_code=201)
async def save_analysis(body: SaveAnalysisRequest, user: dict = Depends(get_current_user)):
    pool = await _get_db_pool()
    created_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO analyses (type, created_at, created_by, model, title, session_id, customer_context, stats, result_text, log_snippet) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (body.type, created_at, user["username"], body.model, body.title, body.session_id,
                 body.customer_context, json.dumps(body.stats, ensure_ascii=False), body.result_text, body.log_snippet),
            )
            analysis_id = cur.lastrowid
        await conn.commit()
    return {"id": analysis_id, "created_at": created_at}


@app.get("/api/analyses")
async def list_analyses(limit: int = 100, _: dict = Depends(get_current_user)):
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT id, type, title, session_id, created_at, created_by, model, customer_context, stats "
                "FROM analyses ORDER BY created_at DESC LIMIT %s",
                (limit,)
            )
            rows = await cur.fetchall()

    sessions: dict = {}
    session_order: list = []
    for r in rows:
        row = dict(r)
        if isinstance(row.get("stats"), str):
            try:
                row["stats"] = json.loads(row["stats"])
            except Exception:
                row["stats"] = {}
        if isinstance(row.get("created_at"), datetime):
            row["created_at"] = row["created_at"].isoformat()
        sid = row["session_id"] or str(row["id"])
        if sid not in sessions:
            session_order.append(sid)
            sessions[sid] = {
                "session_id": sid,
                "title": row["title"] or row["created_at"],
                "created_at": row["created_at"],
                "created_by": row["created_by"],
                "model": row["model"],
                "customer_context": row["customer_context"],
                "stats": row["stats"],
                "entries": [],
            }
        sessions[sid]["entries"].append({"id": row["id"], "type": row["type"]})

    return {"sessions": [sessions[sid] for sid in session_order]}


@app.get("/api/analyses/{analysis_id}")
async def get_analysis(analysis_id: int, _: dict = Depends(get_current_user)):
    pool = await _get_db_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(aiomysql.DictCursor) as cur:
            await cur.execute(
                "SELECT id, type, created_at, created_by, model, customer_context, stats, result_text, log_snippet "
                "FROM analyses WHERE id = %s",
                (analysis_id,)
            )
            row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Analyse nicht gefunden")
    row = dict(row)
    if isinstance(row.get("stats"), str):
        try:
            row["stats"] = json.loads(row["stats"])
        except Exception:
            row["stats"] = {}
    if isinstance(row.get("created_at"), datetime):
        row["created_at"] = row["created_at"].isoformat()
    return row


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
    settings = await _load_settings()
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
        settings = await _load_settings()
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
        settings = await _load_settings()
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
