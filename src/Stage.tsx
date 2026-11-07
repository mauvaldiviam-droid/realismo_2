import {ReactElement} from "react";
import {StageBase, StageResponse, InitialData, Message} from "@chub-ai/stages-ts";
import {LoadResponse} from "@chub-ai/stages-ts/dist/types/load";

/*
 * STAGE DE REALISMO (versión 18)
 *
 * Funciona en segundo plano (usar position: 'NONE').
 *
 * CÓMO FUNCIONA
 *  - Añade al final de cada mensaje tuyo una nota [OOC-realismo: ...] (modifiedMessage es el
 *    único camino que llega al modelo en este chat). La nota contiene:
 *      1) reglas de fidelidad: cada personaje actúa según su tarjeta (personalidad, conocimientos,
 *         objetivos, historia) y necesita una razón PROPIA para hacer lo que pides;
 *      2) la petición de empezar la respuesta con una línea MIND| (decisión del personaje) y,
 *         si track_scene está activo, una línea SCENE| (lugar, hora, ropa, hechos clave).
 *  - Al recibir la respuesta (afterResponse) lee esas líneas, guarda la escena y las reescribe
 *    como comentarios HTML ocultos:  <!-- MIND| ... -->  y  <!-- SCENE| ... -->
 *
 * POR QUÉ SE GUARDAN EN EL MENSAJE (y no se borran)
 *  Las pruebas con Soji (Mars) mostraron que si el stage borra las líneas, el modelo las escribe
 *  solo en el primer turno: al ver en el historial que sus respuestas anteriores no las llevan,
 *  copia ese patrón. Dejándolas en el historial, las escribió en TODOS los turnos y las posturas
 *  variaron (accept / refuse / accept-with-condition). Chub muestra el comentario mientras se
 *  genera el texto y lo oculta en el resultado final.
 *
 * AUTOCORRECCIÓN (v13)
 *  - El primer mensaje del chat (la apertura fija de la tarjeta) NO lo escribe el modelo y nunca
 *    trae las líneas MIND| / SCENE|. El stage lo ignora: no lo toca ni lo cuenta como fallo.
 *  - Pero ese mensaje sí queda en el historial sin las líneas, y el modelo tiende a copiar el
 *    historial. Por eso, mientras no se haya visto ninguna línea en el chat, la nota le explica
 *    que los mensajes anteriores se escribieron antes de este formato y que debe usarlo igual.
 *  - Si una respuesta llega sin las líneas, la nota siguiente se lo recuerda de forma explícita.
 *    El contador de fallos y el "ya se vieron líneas" viajan en el estado del mensaje, así que
 *    swipes y saltos a otros mensajes los restauran correctamente.
 *
 * CORRECCIONES (v14, a partir de los logs de Soji)
 *  - El modelo a veces escribe las líneas en negrita: **MIND|** user_wants: ... | **card_basis:** ...
 *    Eso ensuciaba el primer campo y hacía que "place" se perdiera para siempre. Ahora los nombres
 *    de campo se normalizan (se quitan asteriscos y símbolos) y los valores se limpian.
 *  - Si un campo de la escena estaba vacío se reenviaba vacío y el modelo lo copiaba, quedando
 *    vacío para siempre. Ahora los campos vacíos no se envían y la nota exige no dejar ninguno
 *    vacío (inferirlo de la historia).
 *  - La nota pide que "events" añada el hecho más reciente (antes se quedaba congelado).
 *
 * RESULTADO DE v17 (4 chats x 5 turnos con Soji): 20 de 20 respuestas con MIND al inicio y SCENE,
 * sin ningún fallo de formato (antes: 11/15 y 12/16). Aperturas de 838 a 2476 caracteres. Las
 * posturas fueron coherentes con cada tarjeta (accept / accept-with-condition / hesitate / refuse).
 *
 * v18, dos cambios:
 *  1) RESPUESTAS SIN NARRACIÓN. En un chat, las respuestas 1 y 2 midieron 358 y 401 caracteres, casi
 *     lo que ocupan solo las dos líneas: el modelo escribió MIND y SCENE y nada más, y al ocultar las
 *     líneas el mensaje quedó vacío ("no generó respuesta"). Ahora se mide el texto visible (FICHA
 *     "visible"), si es casi vacío se avisa en el chat con un mensaje de sistema, y la nota siguiente
 *     exige narración. La petición de formato también lo dice siempre.
 *  2) compact_note (opcional, apagado): como el formato ya es estable, la nota larga (~1900
 *     caracteres, ~480 tokens, guardada en CADA mensaje tuyo) puede alternarse con una corta. Se usa
 *     la completa en el turno 1, cada 6 turnos y tras cualquier problema.
 *
 * HALLAZGO CLAVE (v17): en la segunda tanda de fichas, la mayoría de los "fallos" NO eran omisiones:
 * el modelo sí escribía la decisión y la escena, pero con otro formato que la lectura estricta no
 * reconocía: una lista numerada ("1. MIND| ... / 2. SCENE| ...", tres turnos seguidos y visible en el
 * chat) y un bloque HTML de varias líneas ("<strong>MIND:</strong><small><em>user_wants:</em>...").
 * Ahora la cabecera se lee de forma tolerante (ver extractHead): sin importar etiquetas HTML,
 * comentarios, asteriscos, números, viñetas ni "|" o ":" como separador, y el stage guarda siempre
 * las líneas en un formato único <!-- MIND| ... -->, lo que además uniformiza el historial.
 *
 * RESULTADO DE LAS FICHAS (16 turnos, 4 chats con Soji): 12 bien y 4 fallos. Dos de los cuatro chats
 * fallaron en el PRIMER turno y eran los de apertura más larga (4003 y 6409 caracteres; los que
 * acertaron tenían 2186 y 3101). Los fallos a mitad de chat fueron raros. Tras cada fallo, la nota
 * reforzada logró que el modelo volviera a cumplir en 1-2 turnos. Las respuestas cortas NO fueron
 * la causa (hubo respuestas de ~360 caracteres con las líneas puestas).
 *
 * seed_opening (v16, experimento): añade a la apertura de la tarjeta unas líneas MIND| y SCENE|
 * ocultas de ejemplo, para que el historial no empiece "sin formato". Depende de que Chub guarde
 * los cambios hechos al primer mensaje; si no los guarda, no pasa nada (queda como antes).
 *
 * DIAGNÓSTICO (v15): "a veces funciona y otras no". Cada respuesta imprime una línea
 * "realismo: FICHA {...}" con: turno, ok, si hubo MIND y SCENE, largo de la respuesta, de tu mensaje,
 * de la apertura y de la respuesta anterior, y largo de la nota. Cuando falla, además imprime el
 * inicio de la respuesta cruda. Con varias fichas se pueden comparar los casos buenos y los malos.
 *
 * SIN MODELO COMPATIBLE: con el modelo gratuito el formato se ignora. Pon ask_mind: false para
 * usar solo un recordatorio corto en lenguaje natural.
 *
 * COSTO: la nota (~300 tokens) queda guardada en cada mensaje tuyo y cada respuesta guarda sus
 * líneas ocultas (~60-120 tokens). En chats muy largos conviene acortarla.
 *
 * La línea MIND| se muestra en la consola (F12) para revisar por qué decidió el personaje.
 * Si haces swipe o saltas a otro mensaje, setState restaura la escena de ese mensaje.
 */

type Scene = {
    place: string;
    time: string;
    clothing: string;
    events: string;
};

type MessageStateType = {scene: Scene | null; seen?: boolean; streak?: number; empty?: number; turn?: number};
type Health = {seen: boolean; streak: number; empty?: number};
type ConfigType = any;
type InitStateType = any;
type ChatStateType = any;

const DEFAULTS = {
    // Reglas de fidelidad a la tarjeta
    npc_independence: true,
    // true = pide la línea MIND| antes de narrar (funciona con modelos de Mars, p. ej. Soji);
    // false = recordatorio corto sin pedir formato (para modelos que ignoran el formato)
    ask_mind: true,
    // Memoria de escena (lugar, hora, ropa, hechos). En prueba.
    track_scene: true,
    // Muestra bajo cada respuesta lo que el stage recuerda de la escena
    show_scene_note: false,
    // EXPERIMENTO: añade líneas MIND|/SCENE| ocultas de ejemplo a la apertura de la tarjeta
    seed_opening: true,
    // OPCIONAL: alterna la nota completa con una corta para gastar menos contexto (ver cabecera)
    compact_note: false,
    custom_rules: "",
};

// Pon true para ver en la consola el inicio y el final de cada respuesta
const DEBUG = false;

// Marca única: permite reconocer y reemplazar la nota (evita duplicarla al regenerar)
const NOTE_START = "[-realismo:";
const NOTE_RE = /\n*\[-realismo:[\s\S]*\]\s*$/;

const INDEPENDENCE_RULES =
    "Fidelity check: every character acts only according to their established personality, knowledge, goals and history. " +
    "The user asking for something is never a reason by itself: the character needs a reason of their own, otherwise they question it, hesitate, set conditions or refuse, as that person really would. " +
    "Trivial everyday requests need no special reason. A character who is naive, obedient or oblivious by design stays that way. " +
    "If own_reason is 'none', the stance cannot be accept, and your reply must follow the stance. Never write only the actions of the user if the user mentioned the name of a specific character to perform an action or if, based on the events, it makes sense for the character's actions to be mentioned in the narration. Otherwise, you should narrate what happens to the user and those who are with them. If the user only mentions that they are observing, analyzing, etc., then only the characteristics of what they observe or analyze should be narrated.";

const REMINDER_RULES =
    "Reminder: stay faithful to each character's established personality, knowledge, goals and history. " +
    "The user asking for something is not a reason by itself: before a character agrees to or does what the user asks, they need a reason of their own; otherwise they question it, hesitate, set conditions or refuse, as that person really would. " +
    "Trivial everyday requests need no special reason, and a character who is naive or obedient by design stays that way. Never write only the actions of the user if the user mentioned the name of a specific character to perform an action or if, based on the events, it makes sense for the character's actions to be mentioned in the narration. Otherwise, you should narrate what happens to the user and those who are with them. If the user only mentions that they are observing, analyzing, etc., then only the characteristics of what they observe or analyze should be narrated.";

const MIND_ASK =
    "MIND| user_wants: ... | card_basis: ... | own_reason: ... | stance: ... (fill every field with real content; allowed stances: accept, accept-with-condition, counter-offer, hesitate, refuse). " +
    "Example of the MIND line: MIND| user_wants: borrow the character's phone | card_basis: private and distrustful of strangers | own_reason: none | stance: hesitate";

// Refuerzos para la nota (solo cuando hacen falta)
const OPENING_NUDGE =
    "Important: the earlier messages of this chat (for example the opening message) were written before this format existed and do not contain these lines. Ignore that: every reply from now on MUST begin with them.";
const MISSED_NUDGE =
    "Important: your previous reply did not begin with the required lines. This reply MUST begin with them.";

const NARRATION_NUDGE =
    "Important: your previous reply contained only the lines and no narration. After the lines you MUST write the full in-character reply (narration and dialogue).";

// Nota corta (compact_note): se usa cuando el formato ya es estable
const SHORT_RULES =
    "Stay faithful to each character's card: they need a reason of their own to do what the user asks (if own_reason is 'none', the stance cannot be accept). Never write only the actions of the user if the user mentioned the name of a specific character to perform an action or if, based on the events, it makes sense for the character's actions to be mentioned in the narration. Otherwise, you should narrate what happens to the user and those who are with them. If the user only mentions that they are observing, analyzing, etc., then only the characteristics of what they observe or analyze should be narrated.";
const COMPACT_EVERY = 6; // la nota completa se repite en los turnos 1, 7, 13...
const MIN_VISIBLE = 15; // menos caracteres visibles que esto = respuesta sin narración

const SCENE_ASK =
    "SCENE| place: ... | time: ... | clothing: ... | events: ... " +
    "(never leave a field empty: infer it from the story; events = the important things that happened so far, add this turn's newest one, max 8 items separated by '; ', drop the oldest)";

const SCENE_EXAMPLE =
    " Example of the SCENE line: SCENE| place: beach near the lighthouse | time: afternoon | clothing: Spinel: oversized boots; user: unknown | events: arrived at the beach; the user proposed exploring a cave";

// Línea de decisión del personaje. Acepta cualquier símbolo, emoji, asterisco o "<!-- " delante
// (el modelo imita el formato oculto que ve en el historial).
const MIND_LINE_RE = /^[^A-Za-z\r\n]*MIND\**[ \t]*\|(.*)$/im;
// Línea de escena (misma tolerancia)
const SCENE_LINE_RE = /^[^A-Za-z\r\n]*SCENE\**[ \t]*\|(.*)$/im;
// Respaldo: bloque [scene]...[/scene] o <scene>...</scene>
const SCENE_RE = /(?:<|\[)scene(?:>|\])([\s\S]*?)(?:<|\[)\/scene(?:>|\])/i;
const SCENE_OPEN_RE = /(?:<|\[)scene(?:>|\])/i;

// Normaliza un nombre de campo: "** Place", "**place" o "place" -> "place"
function fieldKey(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z_]/g, "");
}

// Quita asteriscos y espacios sobrantes de un valor: "** late evening **" -> "late evening"
function fieldValue(raw: string): string {
    return raw.replace(/^[\s*]+|[\s*]+$/g, "");
}

// Quita el ")" o el "-->" finales que quedan cuando la línea viene dentro de un comentario
function tidyLine(v: string): string {
    return v.trim().replace(/(\)|-->)\s*$/, "").trim();
}

function stripMind(text: string): {mind: string | null; rest: string} {
    const m = text.match(MIND_LINE_RE);
    if (!m) return {mind: null, rest: text};
    const mind = tidyLine(m[1]).replace(/\*+/g, "").replace(/\s+/g, " ").trim();
    return {mind, rest: text.replace(MIND_LINE_RE, "").trim()};
}

// "unknown", "none", "..." etc. cuentan como vacío: así no pisan un dato bueno ya guardado
const EMPTY_VALUES = /^(unknown|none|n\/a|\?|\.{2,}|…|desconocid[oa]|ninguno|ninguna)$/i;

function clean(v: string): string {
    const t = v.trim().replace(/^<+|>+$/g, "").trim();
    return EMPTY_VALUES.test(t) ? "" : t;
}

function toScene(fields: Record<string, string>): Scene | null {
    const scene: Scene = {
        place: clean(fields["place"] ?? ""),
        time: clean(fields["time"] ?? ""),
        clothing: clean(fields["clothing"] ?? ""),
        events: clean(fields["events"] ?? ""),
    };
    const empty = !scene.place && !scene.time && !scene.clothing && !scene.events;
    return empty ? null : scene;
}

function parseScene(text: string): {scene: Scene | null; cleaned: string} {
    // 1) Línea SCENE| ... (también dentro de un comentario <!-- ... -->)
    const line = text.match(SCENE_LINE_RE);
    if (line) {
        const lineFields: Record<string, string> = {};
        for (const part of tidyLine(line[1]).split("|")) {
            const i = part.indexOf(":");
            if (i > 0) lineFields[fieldKey(part.slice(0, i))] = fieldValue(part.slice(i + 1));
        }
        return {scene: toScene(lineFields), cleaned: text.replace(SCENE_LINE_RE, "").trim()};
    }

    // 2) Respaldo: bloque [scene]...[/scene]
    const m = text.match(SCENE_RE);
    if (!m) {
        // Bloque abierto pero sin cerrar (respuesta cortada): se quita igual
        const open = text.search(SCENE_OPEN_RE);
        if (open >= 0) return {scene: null, cleaned: text.slice(0, open).trimEnd()};
        return {scene: null, cleaned: text};
    }
    const fields: Record<string, string> = {};
    for (const l of m[1].split(/\r?\n/)) {
        const i = l.indexOf(":");
        if (i > 0) fields[fieldKey(l.slice(0, i))] = fieldValue(l.slice(i + 1));
    }
    return {scene: toScene(fields), cleaned: text.replace(SCENE_RE, "").trim()};
}

// Si el modelo deja un campo vacío, se conserva el valor anterior
function mergeScene(prev: Scene | null, next: Scene): Scene {
    return {
        place: next.place || prev?.place || "",
        time: next.time || prev?.time || "",
        clothing: next.clothing || prev?.clothing || "",
        events: next.events || prev?.events || "",
    };
}

// Solo incluye los campos con contenido (un campo vacío se copiaría vacío para siempre)
function sceneToLine(s: Scene): string {
    return [
        s.place && `place: ${s.place}`,
        s.time && `time: ${s.time}`,
        s.clothing && `clothing: ${s.clothing}`,
        s.events && `events: ${s.events}`,
    ]
        .filter(Boolean)
        .join(" | ");
}

function sceneNote(s: Scene): string {
    const parts = [
        s.place && `Lugar: ${s.place}`,
        s.time && `Hora: ${s.time}`,
        s.clothing && `Ropa: ${s.clothing}`,
    ].filter(Boolean);
    return parts.join(" | ");
}

// Comentario HTML oculto. Dentro no puede haber saltos de línea ni "--" (cerraría el comentario)
function hiddenComment(label: string, body: string): string {
    const safe = body.replace(/[\r\n]+/g, " ").replace(/-{2,}/g, "-").replace(/\s+/g, " ").trim();
    return `<!-- ${label}| ${safe} -->`;
}

// ---------- Lectura tolerante de la cabecera ----------
// El modelo no siempre respeta el formato exacto. Casos reales: "1. MIND| ... / 2. SCENE| ...",
// "MIND:" con dos puntos y bloques HTML de varias líneas (<strong>MIND:</strong><small><em>user_wants:</em>).
// Por eso se lee el INICIO de la respuesta línea a línea sobre una versión "plana" (sin etiquetas HTML,
// comentarios, asteriscos ni símbolos o números delante) y se consumen las líneas que pertenecen a
// MIND/SCENE hasta llegar a la primera línea de narración.
const MIND_KEYS = ["user_wants", "card_basis", "own_reason", "stance"];
const SCENE_KEYS = ["place", "time", "clothing", "events"];
const ALL_KEYS = new Set([...MIND_KEYS, ...SCENE_KEYS]);
const HEADER_RE = /^(MIND|SCENE)\s*[|:]\s*(.*)$/;

function plainLine(raw: string): string {
    return raw
        .replace(/<!--|-->/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/[*`]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[^A-Za-z]+/, "");
}

// Lee pares "clave: valor" separados por "|". Fuera de una línea MIND|/SCENE| (loose = false) las
// claves de escena solo valen en minúsculas, para no confundir la narración con la cabecera.
function addPairs(fields: Record<string, string>, str: string, loose: boolean): boolean {
    let added = false;
    for (const part of str.split("|")) {
        const i = part.indexOf(":");
        if (i <= 0) continue;
        const rawKey = part.slice(0, i).trim();
        const key = fieldKey(rawKey);
        if (!ALL_KEYS.has(key)) continue;
        if (!loose && SCENE_KEYS.includes(key) && rawKey !== key) continue;
        fields[key] = fieldValue(part.slice(i + 1));
        added = true;
    }
    return added;
}

function extractHead(text: string): {fields: Record<string, string>; rest: string; found: boolean} {
    const lines = text.split(/\r?\n/);
    const fields: Record<string, string> = {};
    let end = -1; // índice de la última línea que pertenece a la cabecera
    let i = 0;
    while (i < lines.length) {
        const plain = plainLine(lines[i]);
        if (plain === "") {
            i++; // línea en blanco o solo con etiquetas: se permite
            continue;
        }
        const header = plain.match(HEADER_RE);
        if (header) {
            addPairs(fields, header[2], true);
            end = i;
            i++;
            continue;
        }
        if (addPairs(fields, plain, false)) {
            end = i;
            i++;
            continue;
        }
        break; // primera línea de narración
    }
    if (end < 0) return {fields, rest: text, found: false};
    return {fields, rest: lines.slice(end + 1).join("\n").trim(), found: true};
}

// Procesa una respuesta del modelo: lee MIND y SCENE, actualiza la escena y devuelve el texto
// que se guarda (las líneas, ocultas, al inicio; el resto igual).
function processReply(
    content: string,
    cfg: typeof DEFAULTS,
    prevScene: Scene | null
): {
    text: string;
    scene: Scene | null;
    mind: string | null;
    gotMind: boolean;
    gotScene: boolean;
    mindWhere: "inicio" | "texto" | "no";
    visibleLen: number;
} {
    // 1) Cabecera tolerante (lo normal: las líneas están al inicio)
    const head = extractHead(content);
    let text = head.found ? head.rest : content;

    // 2) Decisión del personaje
    const headMind = MIND_KEYS.filter((k) => head.fields[k] !== undefined)
        .map((k) => `${k}: ${head.fields[k]}`)
        .join(" | ");
    let mind: string | null = headMind || null;
    let mindWhere: "inicio" | "texto" | "no" = mind !== null ? "inicio" : "no";
    if (mind === null) {
        // Respaldo: una línea MIND| en cualquier parte del texto
        const sm = stripMind(text);
        mind = sm.mind;
        text = sm.rest;
        if (mind !== null) mindWhere = "texto";
    }

    // 3) Escena
    const headHasScene = SCENE_KEYS.some((k) => head.fields[k] !== undefined);
    let gotScene = headHasScene;
    let found: Scene | null = headHasScene ? toScene(head.fields) : null;
    if (!headHasScene) {
        gotScene = SCENE_LINE_RE.test(text) || SCENE_RE.test(text);
        if (cfg.track_scene) {
            const parsed = parseScene(text);
            text = parsed.cleaned;
            found = parsed.scene;
        }
    }
    const scene = cfg.track_scene && found ? mergeScene(prevScene, found) : prevScene;

    // 4) Líneas que se guardan (ocultas) al inicio del mensaje, para que el modelo las vea
    //    en el historial y siga escribiéndolas, siempre en el mismo formato
    const hidden: string[] = [];
    if (cfg.ask_mind && mind) hidden.push(hiddenComment("MIND", mind));
    if (cfg.track_scene && scene && sceneToLine(scene)) hidden.push(hiddenComment("SCENE", sceneToLine(scene)));

    return {
        text: hidden.length > 0 ? `${hidden.join("\n")}\n\n${text}` : text,
        scene,
        mind,
        gotMind: mind !== null,
        gotScene,
        mindWhere,
        visibleLen: text.trim().length,
    };
}

// Añade a la apertura de la tarjeta las líneas ocultas de ejemplo (solo las que se están pidiendo).
// Los valores de SCENE son "unknown": cuentan como vacíos y no ensucian la escena guardada.
function seedOpening(content: string, cfg: typeof DEFAULTS): string {
    const lines: string[] = [];
    if (cfg.npc_independence && cfg.ask_mind) {
        lines.push(
            hiddenComment(
                "MIND",
                "user_wants: nothing yet, the chat is just starting | card_basis: the characters as described in their cards | own_reason: sets the scene | stance: accept"
            )
        );
    }
    if (cfg.track_scene) {
        lines.push(hiddenComment("SCENE", "place: unknown | time: unknown | clothing: unknown | events: unknown"));
    }
    return lines.length > 0 ? `${lines.join("\n")}\n\n${content}` : content;
}

// Devuelve "" si no hay nada que pedir (todo apagado).
// compact = true genera la versión corta (solo cuando el formato ya es estable).
function buildNote(cfg: typeof DEFAULTS, scene: Scene | null, health: Health, compact = false): string {
    const bits: string[] = [];
    const mindOn = cfg.npc_independence && cfg.ask_mind;
    const sceneLine = cfg.track_scene && scene ? sceneToLine(scene) : "";

    const lines: string[] = [];
    if (mindOn) lines.push(MIND_ASK);
    if (cfg.track_scene) lines.push(SCENE_ASK);

    const extra = (cfg.custom_rules ?? "").trim();

    if (compact && lines.length > 0) {
        if (cfg.npc_independence) bits.push(mindOn ? SHORT_RULES : REMINDER_RULES);
        if (extra) bits.push(extra);
        if (sceneLine) bits.push(`Current scene: SCENE| ${sceneLine}`);
        const labels = [mindOn && "MIND|", cfg.track_scene && "SCENE|"].filter(Boolean).join(" and ");
        bits.push(
            `Begin your reply with the ${labels} ${lines.length === 1 ? "line" : "lines"} in the same format as your previous replies, ` +
            "then continue with the full in-character reply (narration and dialogue)."
        );
        return `${NOTE_START} ${bits.join(" ")}]`;
    }

    if (cfg.npc_independence) bits.push(mindOn ? INDEPENDENCE_RULES : REMINDER_RULES);
    if (extra) bits.push(extra);
    if (sceneLine) bits.push(`Current scene: SCENE| ${sceneLine}`);

    if (lines.length > 0) {
        const count = lines.length === 1 ? "ONE line" : "TWO lines";
        bits.push(
            `Begin your reply with ${count}, before any narration, dialogue or asterisk, in exactly this format, with the values filled in for the current moment, each on its own line, then continue with your normal reply: ` +
            lines.join(" then, on the next line, ") +
            " Write real values, not placeholders. Do this for EVERY reply, even a very short one. After the lines, ALWAYS continue with the full in-character reply (narration and dialogue); never end the message after the lines."
        );
        if (cfg.track_scene && !scene) bits.push(SCENE_EXAMPLE.trim());
        if (!health.seen) bits.push(OPENING_NUDGE);
        if (health.streak > 0) bits.push(MISSED_NUDGE);
        if ((health.empty ?? 0) > 0) bits.push(NARRATION_NUDGE);
    }

    if (bits.length === 0) return "";
    return `${NOTE_START} ${bits.join(" ")}]`;
}

export class Stage extends StageBase<InitStateType, ChatStateType, MessageStateType, ConfigType> {
    scene: Scene | null = null;
    seen = false; // ya se vio al menos una línea MIND| o SCENE| en este chat (rama actual)
    streak = 0; // respuestas seguidas sin las líneas pedidas
    userTurns = 0; // mensajes tuyos procesados desde que se cargó el stage
    emptyStreak = 0; // respuestas seguidas sin narración (solo las líneas)
    turn = 0; // mensajes tuyos en este chat (viaja en el estado; sirve para alternar la nota)
    lastNoteCompact = false;
    // Solo para diagnóstico (largos en caracteres)
    openingLen = 0;
    lastUserLen = 0;
    lastNoteLen = 0;
    prevReplyLen = 0;
    cfg = {...DEFAULTS};

    constructor(data: InitialData<InitStateType, ChatStateType, MessageStateType, ConfigType>) {
        super(data);
        const c: any = data.config ?? {};
        this.cfg = {
            npc_independence: c.npc_independence ?? DEFAULTS.npc_independence,
            ask_mind: c.ask_mind ?? DEFAULTS.ask_mind,
            track_scene: c.track_scene ?? DEFAULTS.track_scene,
            show_scene_note: c.show_scene_note ?? DEFAULTS.show_scene_note,
            seed_opening: c.seed_opening ?? DEFAULTS.seed_opening,
            compact_note: c.compact_note ?? DEFAULTS.compact_note,
            custom_rules: c.custom_rules ?? DEFAULTS.custom_rules,
        };
        this.restore(data.messageState);
        console.log("realismo: stage cargado", data.config);
    }

    async load(): Promise<Partial<LoadResponse<InitStateType, ChatStateType, MessageStateType>>> {
        return {success: true, error: null};
    }

    private restore(state: MessageStateType | null | undefined): void {
        this.scene = state?.scene ?? null;
        this.seen = state?.seen ?? false;
        this.streak = state?.streak ?? 0;
        this.emptyStreak = state?.empty ?? 0;
        this.turn = state?.turn ?? 0;
    }

    private snapshot(): MessageStateType {
        return {scene: this.scene, seen: this.seen, streak: this.streak, empty: this.emptyStreak, turn: this.turn};
    }

    // Swipe o salto a otro mensaje: se restaura el estado que tenía ese mensaje
    async setState(state: MessageStateType): Promise<void> {
        this.restore(state);
    }

    async beforePrompt(userMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        this.userTurns += 1;
        this.turn += 1;
        console.log(
            `realismo: beforePrompt | turno ${this.turn} | escena actual:`, this.scene,
            `| líneas vistas: ${this.seen} | fallos seguidos: ${this.streak} | sin narración: ${this.emptyStreak}`
        );

        // Se quita una nota anterior (por ejemplo al regenerar) y se añade la nueva
        const base = userMessage.content.replace(NOTE_RE, "").trimEnd();
        // Nota corta solo si está activada, el formato ya es estable y no toca repetir la completa
        const healthy = this.seen && this.streak === 0 && this.emptyStreak === 0;
        const compact = this.cfg.compact_note && healthy && this.turn % COMPACT_EVERY !== 1;
        this.lastNoteCompact = compact;
        const note = buildNote(this.cfg, this.scene, {seen: this.seen, streak: this.streak, empty: this.emptyStreak}, compact);
        this.lastUserLen = base.length;
        this.lastNoteLen = note.length;
        console.log(`realismo: nota añadida al mensaje, largo ${note.length}${compact ? " (compacta)" : ""}`);

        return {
            modifiedMessage: note ? `${base}\n\n${note}` : base,
            messageState: this.snapshot(),
        };
    }

    async afterResponse(botMessage: Message): Promise<Partial<StageResponse<ChatStateType, MessageStateType>>> {
        const full = botMessage.content;

        // Mensaje de apertura de la tarjeta: llega antes de tu primer mensaje y no lo escribió el modelo.
        // No se procesa ni cuenta como fallo. Con seed_opening se le añaden líneas ocultas de ejemplo
        // (si ya las trae, se deja tal cual).
        if (this.userTurns === 0) {
            this.openingLen = full.length;
            const hasLines = extractHead(full).found || MIND_LINE_RE.test(full) || SCENE_LINE_RE.test(full);
            if (!hasLines && this.cfg.seed_opening) {
                const seeded = seedOpening(full, this.cfg);
                if (seeded !== full) {
                    console.log(`realismo: mensaje de apertura (largo ${full.length}): se le añaden líneas ocultas de ejemplo`);
                    return {modifiedMessage: seeded};
                }
            }
            console.log(`realismo: mensaje de apertura del chat, se deja igual (largo ${full.length})`);
            return {};
        }

        const result = processReply(full, this.cfg, this.scene);
        console.log(
            `realismo: afterResponse | largo ${full.length} | MIND: ${result.mindWhere} | SCENE: ${result.gotScene ? "sí" : "no"}`
        );
        if (DEBUG) {
            console.log("realismo: inicio ->", full.slice(0, 200));
            console.log("realismo: final ->", full.slice(-500));
        }

        this.scene = result.scene;
        if (result.mind) console.log("realismo: decisión del personaje ->", result.mind);
        if (this.cfg.track_scene) console.log("realismo: escena guardada ->", this.scene);

        // Seguimiento de si el modelo cumple el formato
        const mindOn = this.cfg.npc_independence && this.cfg.ask_mind;
        const asked = mindOn || this.cfg.track_scene;
        let complete = true;
        let empty = false;
        if (asked) {
            complete = (!mindOn || result.gotMind) && (!this.cfg.track_scene || result.gotScene);
            this.streak = complete ? 0 : this.streak + 1;
            if (result.gotMind || result.gotScene) this.seen = true;
            if (this.streak >= 3) {
                console.warn(`realismo: AVISO el modelo no escribió las líneas ${this.streak} veces seguidas`);
            }

            // Respuesta sin narración: escribió las líneas y nada más (el mensaje visible queda vacío)
            empty = result.visibleLen < MIN_VISIBLE;
            this.emptyStreak = empty ? this.emptyStreak + 1 : 0;
            if (empty) {
                console.warn(`realismo: AVISO respuesta sin narración (texto visible: ${result.visibleLen} caracteres)`);
            }
        }

        // Ficha de diagnóstico (copiable): sirve para comparar los turnos buenos con los malos
        console.log(
            "realismo: FICHA",
            JSON.stringify({
                turno: this.turn,
                ok: complete && !empty,
                mind: result.gotMind,
                dondeMind: result.mindWhere,
                scene: result.gotScene,
                respuesta: full.length,
                visible: result.visibleLen,
                mensaje: this.lastUserLen,
                apertura: this.openingLen,
                respuestaAnterior: this.prevReplyLen,
                nota: this.lastNoteLen,
                notaCompacta: this.lastNoteCompact,
                racha: this.streak,
                sinNarracion: this.emptyStreak,
            })
        );
        if (asked && !complete) {
            console.log("realismo: FALLO, inicio de la respuesta ->", full.slice(0, 300));
        }
        this.prevReplyLen = full.length;

        let note: string | null = null;
        if (empty) {
            note = "Realismo: la respuesta llegó sin narración (solo las líneas internas). Puedes regenerarla.";
        } else if (this.cfg.track_scene && this.cfg.show_scene_note) {
            note = this.scene
                ? sceneNote(this.scene)
                : "Realismo activo (el modelo aún no envió la línea de escena)";
        }

        return {
            modifiedMessage: result.text !== full ? result.text : null,
            messageState: this.snapshot(),
            systemMessage: note,
        };
    }

    // Con position: 'NONE' esto no se muestra; el stage trabaja en segundo plano
    render(): ReactElement {
        return <div style={{display: "none"}} />;
    }
}
