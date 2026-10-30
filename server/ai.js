// Understands WhatsApp messages for the bot: is it a new task, a "done" report, a change request, or just chat?
// Works without any AI using built-in rules (English + Hinglish). Set AI_PROVIDER + AI_API_KEY (+ AI_MODEL / AI_BASE_URL)
// to use an AI model instead; if the AI call fails, the rules are used so the bot never stops.

const DONE_RX = /\b(done|completed?|complete ho|finished|finish ho|ho\s*gaya|ho\s*gya|hogaya|hogya|kar\s*diya|kr\s*diya|kar\s*di|kr\s*di|delivered|uploaded|submitted|sent it|posted it|ready now|is ready|are ready)\b|✅|☑️|✔️/i;
const CHANGE_RX = /\b(change|changes|changed|update|updates|modify|modification|revise|revision|revisions|correction|corrections|correct it|replace|instead|edit|edits|tweak|badal|badlo|badalna|alter|redo|re-do|make it|should be)\b/i;
const TASK_RX = /\b(please|pls|plz|kindly|can you|could you|can u|need|needs|want|wanted|make|create|design|prepare|send|post|share|add|write|setup|set up|fix|build|edit|shoot|record|upload|schedule|launch|karna|karo|kar do|kr do|bana|banao|banana|chahiye|bhejo|bhej do|dalo|daal do|task|todo|to-do|deadline|by tomorrow|by today|asap|urgent|kal tak|aaj)\b|\?$/im;
const CHATTER_RX = /^(ok|okay|k|kk|okk|thanks|thank you|thanku|thx|ty|noted|sure|great|nice|good|cool|hmm|hm|yes|no|ji|haan|ha|accha|acha|theek|thik|fine|👍|🙏|👌|😊|🙂|❤️|done)[.! ]*$/i;
const STOP = new Set(('the a an and or to of for in on at by with from this that these those is are was were be been it its i we you he she they me my our your ' +
  'please pls plz kindly can could would will shall should need needs make do done task tasks completed complete finished have has had ' +
  'ho gaya gya hogaya kar diya kr di hai hain ka ki ke ko se me mein aur bhi ye yeh woh wo ek abhi now today tomorrow sir mam maam ji bhai').split(' '));

export const tokens = (text) => String(text || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').split(/[^a-z0-9ऀ-ॿ]+/)
  .filter((w) => w.length > 2 && !STOP.has(w));
export function overlap(a, b) {
  const A = new Set(tokens(a));
  return [...new Set(tokens(b))].filter((w) => A.has(w) || [...A].some((x) => x.length > 4 && w.length > 4 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))))).length;
}
// Greetings at the start of a message aren't part of the task ("Hi team, please design…" → "Please design…").
const GREETING_RX = /^(hi|hii+|hello|hey|hola|namaste|dear|good\s+(morning|afternoon|evening))\b(\s+(team|all|guys|everyone|sir|mam|ma'am|ji|bro|bhai|there))?[\s,!.:;-]*/i;
const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim().replace(GREETING_RX, '').trim()).find(Boolean) || '';
export function shortTitle(text, max = 90) {
  let t = firstLine(text).replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// Best matching task for a piece of text (score = shared words; a reply-to link always wins).
export function rankTasks(text, tasks) {
  return tasks.map((t) => ({ ...t, score: overlap(text, `${t.title} ${t.client_name || ''}`) }))
    .filter((t) => t.score > 0).sort((a, b) => b.score - a.score);
}

function heuristic({ text, hasMedia, sender, openTasks, recentTasks }) {
  const clean = String(text || '').trim();
  const done = DONE_RX.test(clean);
  if (sender?.isEmployee && done) return { kind: 'done', title: shortTitle(clean), details: clean };
  if (!clean && hasMedia) return { kind: 'task', title: 'Files shared in the group', details: '' };
  if (!clean || (CHATTER_RX.test(clean) && !hasMedia)) return { kind: 'other' };
  const changeable = recentTasks?.length ? recentTasks : openTasks;
  if (CHANGE_RX.test(clean) && changeable.length) {
    const best = rankTasks(clean, changeable)[0];
    if (best) return { kind: 'change', task_id: best.id, title: shortTitle(clean), details: clean };
  }
  if (done && !sender?.isEmployee) return { kind: 'other' };
  if (TASK_RX.test(clean) || hasMedia || tokens(clean).length >= 6) {
    const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
    return { kind: 'task', title: shortTitle(clean), details: lines.length > 1 || clean.length > 90 ? clean : '' };
  }
  return { kind: 'other' };
}

export function createAI(env) {
  const provider = String(env.AI_PROVIDER || '').toLowerCase();
  const enabled = !!provider && (!!env.AI_API_KEY || provider === 'ollama');

  async function complete(system, user) {
    if (provider === 'anthropic') {
      const res = await fetch(`${(env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': env.AI_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: env.AI_MODEL || 'claude-haiku-5-5', max_tokens: 700, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`AI ${res.status}`);
      const data = await res.json();
      return data.content?.map((c) => c.text || '').join('') || '';
    }
    // OpenAI-compatible: OpenAI, Groq, OpenRouter, Together, Gemini (OpenAI endpoint), Ollama, LM Studio…
    const base = (env.AI_BASE_URL || (provider === 'ollama' ? 'http://localhost:11434/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.AI_API_KEY ? { Authorization: `Bearer ${env.AI_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: env.AI_MODEL || 'gpt-4o-mini', temperature: 0, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`AI ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  const SYSTEM = `You read WhatsApp messages from a digital agency's client groups and decide what they mean for the task dashboard.
Messages may be English, Hindi or Hinglish, split across several lines, with attachments.
Return ONLY a JSON object: {"kind": "task"|"done"|"change"|"other", "title": string, "details": string, "task_id": number|null}
- "task": someone asks for new work. title = short imperative summary (max 80 chars, same language as the request is fine). details = the full request, cleaned up, keep every requirement, link and date.
- "done": an EMPLOYEE says some work is finished. title = what was finished. task_id = id from "their open tasks" if one clearly matches, else null.
- "change": a change/correction/update to existing work. task_id = id from "open tasks for this client" that it changes (null if unclear). details = exactly what must change.
- "other": greetings, thanks, acknowledgements, chit-chat, questions that are not work requests.
Never invent ids. Prefer "other" for messages like "ok", "thanks", "👍".`;

  async function analyze(input) {
    const base = heuristic(input);
    if (!enabled) return { ...base, by: 'rules' };
    try {
      const user = [
        `Group: ${input.groupName || '(direct message)'}${input.clientName ? ` (client: ${input.clientName})` : ''}`,
        `Sender: ${input.sender?.name || 'unknown'} — ${input.sender?.isEmployee ? 'EMPLOYEE of the agency' : input.sender?.isOwner ? 'agency owner' : 'client / outsider'}`,
        `Attachments: ${input.mediaTypes?.length ? input.mediaTypes.join(', ') : 'none'}`,
        `Open tasks for this client: ${JSON.stringify((input.openTasks || []).slice(0, 25).map((t) => ({ id: t.id, title: t.title, assignees: t.assignees })))}`,
        input.recentTasks?.length ? `Recently finished tasks for this client (changes may refer to these too): ${JSON.stringify(input.recentTasks.filter((t) => t.status === 'done').slice(0, 15).map((t) => ({ id: t.id, title: t.title })))}` : '',
        input.sender?.isEmployee ? `Their open tasks: ${JSON.stringify((input.myTasks || []).slice(0, 25).map((t) => ({ id: t.id, title: t.title, client: t.client_name })))}` : '',
        `Messages (oldest first):\n${input.text || '(no text)'}`,
      ].filter(Boolean).join('\n');
      const raw = await complete(SYSTEM, user);
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (!['task', 'done', 'change', 'other'].includes(json.kind)) throw new Error('bad kind');
      const known = new Set([...(input.openTasks || []), ...(input.myTasks || []), ...(input.recentTasks || [])].map((t) => t.id));
      return {
        kind: json.kind === 'done' && !input.sender?.isEmployee ? 'other' : json.kind,
        title: String(json.title || base.title || '').slice(0, 120) || shortTitle(input.text),
        details: String(json.details || base.details || ''),
        task_id: known.has(Number(json.task_id)) ? Number(json.task_id) : base.task_id || null,
        by: 'ai',
      };
    } catch (err) {
      console.error('AI analyze failed, using rules', err?.message);
      return { ...base, by: 'rules' };
    }
  }

  return { enabled, provider: enabled ? provider : null, analyze };
}
