import os
import re
import json
import secrets
from typing import Annotated
from fastapi import FastAPI, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
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

app = FastAPI(title="OCPP Log Analyzer")
app.mount("/static", StaticFiles(directory="static"), name="static")

security = HTTPBasic()


def authenticate(credentials: Annotated[HTTPBasicCredentials, Depends(security)]) -> str:
    correct_user = os.getenv("OCPP_USERNAME", "admin")
    correct_pass = os.getenv("OCPP_PASSWORD", "changeme")
    ok = (
        secrets.compare_digest(credentials.username.encode(), correct_user.encode()) and
        secrets.compare_digest(credentials.password.encode(), correct_pass.encode())
    )
    if not ok:
        raise HTTPException(status_code=401, headers={"WWW-Authenticate": "Basic"})
    return credentials.username

MSG_TYPES = {2: "CALL", 3: "CALLRESULT", 4: "CALLERROR"}


def _table_sort_key(line: str) -> tuple:
    parts = line.split(' ', 2)
    ts = parts[0] if parts else ''
    mtype = 9
    if len(parts) >= 3:
        m = _SORT_TYPE_RE.search(parts[2])
        if m:
            mtype = int(m.group(1))
    return (ts, mtype)


class ParseRequest(BaseModel):
    log_content: str = Field(..., max_length=50_000_000)


class AnalyzeRequest(BaseModel):
    log_content: str
    parsed_data: dict
    ollama_url: str
    model: str
    customer_context: str = ""


def is_table_format(log_content: str) -> bool:
    """Erkennt ob der Log im Web-UI Tabellenformat vorliegt (DD.MM.YYYY | HH:MM:SS)."""
    for line in log_content.split("\n")[:15]:
        if _DATE_PATTERN.search(line):
            return True
    return False


def preprocess_table_format(log_content: str) -> str:
    """Konvertiert das Web-UI Tabellenformat in ein für den Parser lesbares Format.

    Eingabe (zwei Zeilen pro Nachricht):
        StatusNotification    03.03.2026 | 13:47:24    to Backend (Request)
        [ 2, "abc123", "StatusNotification", {...} ]

    Ausgabe (eine Zeile):
        2026-03-03T13:47:24.000Z SEND [ 2, "abc123", "StatusNotification", {...} ]
    """
    lines = log_content.split("\n")
    result = []

    i = 0
    while i < len(lines):
        stripped = lines[i].strip()

        # Header-Zeile überspringen
        if "Event type" in stripped and "Date / Time" in stripped:
            i += 1
            continue

        match = _META_PATTERN.match(stripped)
        if match:
            date_str = match.group(2)   # DD.MM.YYYY
            time_str = match.group(3)   # HH:MM:SS
            direction_str = match.group(4).strip()

            day, month, year = date_str.split(".")
            iso_ts = f"{year}-{month}-{day}T{time_str}.000Z"

            direction = (
                "SEND"
                if "to Backend" in direction_str or "from Charging station" in direction_str
                else "RECV"
            )

            # Nächste nicht-leere Zeile muss das JSON sein
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1

            if j < len(lines) and lines[j].strip().startswith("["):
                result.append(f"{iso_ts} {direction} {lines[j].strip()}")
                i = j + 1
                continue

        if stripped:
            result.append(lines[i])
        i += 1

    # Chronologisch sortieren: Timestamp aufsteigend, CALL (2) vor CALLRESULT (3) bei gleichem Timestamp
    result.sort(key=_table_sort_key)
    return "\n".join(result)


def parse_ocpp_logs(log_content: str) -> dict:
    if is_table_format(log_content):
        log_content = preprocess_table_format(log_content)

    messages = []
    errors = []
    warnings = []

    lines = log_content.split("\n")

    call_map = {}       # UniqueId -> CALL message dict
    pending_results = {}  # UniqueId -> CALLRESULT msg (arrived before its CALL)
    has_boot_notification = False

    for line_num, line in enumerate(lines, 1):
        if not line.strip():
            continue

        # Extract timestamp
        timestamp = None
        ts_match = _TS_PATTERN.match(line.strip())
        if ts_match:
            timestamp = ts_match.group(1)

        # Extract direction
        direction = None
        dir_match = _DIR_PATTERN.search(line)
        if dir_match:
            d = dir_match.group(1).upper()
            direction = "SEND" if d in ("SEND", "->") else "RECV"

        # Find OCPP JSON in line
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

        # --- CALL ---
        if msg_type == "CALL" and len(msg_json) >= 3:
            action = msg_json[2]
            payload = msg_json[3] if len(msg_json) > 3 else {}
            msg["action"] = action
            msg["payload"] = payload
            call_map[unique_id] = msg

            if action == "BootNotification":
                has_boot_notification = True

            # CALLRESULT already arrived before this CALL (reverse-ordered log)?
            if unique_id in pending_results:
                result_msg = pending_results.pop(unique_id)
                result_msg["action"] = action
                msg["answered"] = True
                result_payload = result_msg.get("payload", {})
                if isinstance(result_payload, dict):
                    r_status = result_payload.get("status", "")
                    if r_status in ("Rejected", "Faulted", "Invalid"):
                        errors.append(
                            {
                                "line": result_msg["line"],
                                "type": "error",
                                "message": f"CALLRESULT status '{r_status}' für {action}",
                                "detail": json.dumps(result_payload, ensure_ascii=False),
                            }
                        )
                    if action == "StatusNotification":
                        error_code = payload.get("errorCode", "NoError")
                        connector_status = payload.get("status", "")
                        if error_code != "NoError":
                            errors.append(
                                {
                                    "line": line_num,
                                    "type": "error",
                                    "message": f"StatusNotification errorCode: '{error_code}' (Status: {connector_status})",
                                    "detail": json.dumps(payload, ensure_ascii=False),
                                }
                            )
                        elif connector_status == "Faulted":
                            errors.append(
                                {
                                    "line": line_num,
                                    "type": "error",
                                    "message": "StatusNotification: Ladestation meldet 'Faulted'",
                                    "detail": json.dumps(payload, ensure_ascii=False),
                                }
                            )

        # --- CALLRESULT ---
        elif msg_type == "CALLRESULT":
            payload = msg_json[2] if len(msg_json) > 2 else {}
            msg["payload"] = payload

            if unique_id in call_map:
                original_call = call_map[unique_id]
                msg["action"] = original_call.get("action", "Unknown")
                original_call["answered"] = True

                if isinstance(payload, dict):
                    status = payload.get("status", "")
                    # Rejected / Faulted / Invalid in CALLRESULT payload
                    if status in ("Rejected", "Faulted", "Invalid"):
                        errors.append(
                            {
                                "line": line_num,
                                "type": "error",
                                "message": f"CALLRESULT status '{status}' für {msg['action']}",
                                "detail": json.dumps(payload, ensure_ascii=False),
                            }
                        )

                    # StatusNotification: check original CALL payload
                    if original_call.get("action") == "StatusNotification":
                        call_payload = original_call.get("payload", {})
                        error_code = call_payload.get("errorCode", "NoError")
                        connector_status = call_payload.get("status", "")
                        if error_code != "NoError":
                            errors.append(
                                {
                                    "line": original_call["line"],
                                    "type": "error",
                                    "message": f"StatusNotification errorCode: '{error_code}' (Status: {connector_status})",
                                    "detail": json.dumps(
                                        call_payload, ensure_ascii=False
                                    ),
                                }
                            )
                        elif connector_status == "Faulted":
                            errors.append(
                                {
                                    "line": original_call["line"],
                                    "type": "error",
                                    "message": "StatusNotification: Ladestation meldet 'Faulted'",
                                    "detail": json.dumps(
                                        call_payload, ensure_ascii=False
                                    ),
                                }
                            )
            else:
                # CALLRESULT arrived before its CALL (reverse-ordered log)
                pending_results[unique_id] = msg

        # --- CALLERROR ---
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
            msg["action"] = action

            errors.append(
                {
                    "line": line_num,
                    "type": "error",
                    "message": f"CALLERROR: {error_code} – {error_desc} (Aktion: {action})",
                    "detail": json.dumps(error_details, ensure_ascii=False),
                }
            )

        messages.append(msg)

    # Check for unanswered CALLs
    for uid, call_msg in call_map.items():
        if not call_msg.get("answered"):
            action = call_msg.get("action", uid)
            warnings.append(
                {
                    "line": call_msg["line"],
                    "type": "warning",
                    "message": f"Unbeantworteter CALL: {action} (UniqueId: {uid})",
                    "detail": call_msg.get("raw", ""),
                }
            )

    # Check for missing BootNotification
    if not has_boot_notification and messages:
        warnings.append(
            {
                "line": 0,
                "type": "warning",
                "message": "Kein BootNotification im Log gefunden",
                "detail": "Die Ladestation sollte beim Start ein BootNotification senden.",
            }
        )

    stats = {
        "total": len(messages),
        "calls": sum(1 for m in messages if m["type"] == "CALL"),
        "callresults": sum(1 for m in messages if m["type"] == "CALLRESULT"),
        "callerrors": sum(1 for m in messages if m["type"] == "CALLERROR"),
        "errors": len(errors),
        "warnings": len(warnings),
    }

    return {
        "messages": messages,
        "errors": errors,
        "warnings": warnings,
        "stats": stats,
    }


@app.get("/")
async def root(_: Annotated[str, Depends(authenticate)]):
    return FileResponse("static/index.html")


@app.post("/api/parse")
async def parse_logs(request: ParseRequest, _: Annotated[str, Depends(authenticate)]):
    try:
        return parse_ocpp_logs(request.log_content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/models")
async def get_models(ollama_url: str = "http://localhost:11434", _: str = Depends(authenticate)):
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
async def analyze_logs(request: AnalyzeRequest, _: Annotated[str, Depends(authenticate)]):
    stats = request.parsed_data.get("stats", {})
    errors = request.parsed_data.get("errors", [])
    warnings = request.parsed_data.get("warnings", [])

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
                    f"{request.ollama_url}/api/generate",
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

    return StreamingResponse(
        stream_response(), media_type="text/plain; charset=utf-8"
    )


@app.get("/api/search-hardware")
async def search_hardware(vendor: str = "", model: str = "", firmware: str = "", _: str = Depends(authenticate)):
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


@app.post("/api/draft-email")
async def draft_email(request: AnalyzeRequest, _: Annotated[str, Depends(authenticate)]):
    stats    = request.parsed_data.get("stats", {})
    errors   = request.parsed_data.get("errors", [])
    warnings = request.parsed_data.get("warnings", [])

    customer_issue = request.customer_context.strip() or "allgemeine Log-Analyse"

    log_preview = (
        request.log_content[:3000]
        if len(request.log_content) > 3000
        else request.log_content
    )

    system_prompt = """Du bist ein Assistent für Hotline- und Service-Mitarbeiter im Bereich Elektromobilität.
Deine Aufgabe: Erstelle eine verständliche Erklärung, die ein Service-Mitarbeiter nutzen kann,
um einem Endkunden oder einer meldenden Person die Situation rund um die Ladestation zu erläutern.

Regeln:
- Schreibe auf Deutsch, klar und strukturiert (max. 300 Wörter)
- Keine Fachbegriffe – übersetze OCPP-Konzepte in Alltagssprache
  (z.B. "CALL" → "Anfrage", "CALLERROR" → "Fehlermeldung", "BootNotification" → "Einschalten der Ladestation",
   "StatusNotification" → "Statusmeldung der Ladestation", "Heartbeat" → "regelmäßiges Lebenszeichen")
- Zitiere konkrete Datum und Uhrzeit aus dem Log (z.B. „Am 14.01.2024 um 10:22 Uhr meldete die Station einen Erdschlussfehler")
- Verwende NIEMALS relative Zeitangaben wie „heute", „gestern" oder „heute Morgen" – immer das tatsächliche Datum aus dem Log nennen
- Erkläre was die Ladestation gemacht hat, was schiefgelaufen ist (falls etwas), und was das für den Nutzer bedeutet
- Nutze kurze Absätze oder eine einfache Aufzählung
- Kein E-Mail-Format, keine Begrüßung, keine Grußformel – reiner Erklärungstext für den internen Gebrauch
- Tone: sachlich, ruhig, verständnisvoll – geeignet um es dem Kunden weiterzuerklären
- Falls keine Fehler vorhanden: Sag dass alles normal aussieht und beschreibe kurz den Ablauf mit Zeitbezug"""

    context_directive = ""
    if request.customer_context.strip():
        context_directive = (
            f"\n\nPRIMÄRER FOKUS: Deine Erklärung muss direkt und konkret auf das gemeldete Problem "
            f"„{request.customer_context.strip()}" eingehen. "
            f"Beantworte: Bestätigt der Log dieses Problem? Wann genau ist es aufgetreten? Was war die Ursache? "
            f"Alles andere (normale Abläufe etc.) ist nachrangig – das gemeldete Problem steht im Mittelpunkt."
        )

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

Schreibe jetzt die Erklärung (kein E-Mail-Format, kein Betreff, kein Gruß):"""

    async def stream_response():
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                async with client.stream(
                    "POST",
                    f"{request.ollama_url}/api/generate",
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

    return StreamingResponse(
        stream_response(), media_type="text/plain; charset=utf-8"
    )
