// ניתוב פנייה למחלקה בעזרת Claude
const AnthropicMod = require('@anthropic-ai/sdk');
const Anthropic = AnthropicMod.default || AnthropicMod;

let client = null;
let clientKey = null;
function getClient(apiKey) {
  if (!client || clientKey !== apiKey) {
    client = new Anthropic({ apiKey, baseURL: process.env.HD_ANTHROPIC_BASE_URL || undefined, maxRetries: 2 });
    clientKey = apiKey;
  }
  return client;
}

/**
 * @returns {Promise<{departmentId: string|null, reason: string}>}
 */
async function routeTicket(config, { customerName, texts }) {
  const deps = (config.departments || []).filter((d) => d.userId);
  if (!deps.length) return { departmentId: null, reason: 'אין מחלקות מוגדרות' };
  if (!config.ai.enabled || !config.ai.apiKey) return { departmentId: null, reason: 'AI כבוי או בלי מפתח' };

  const ids = deps.map((d) => d.id);
  const system =
    `You route incoming WhatsApp messages sent by customers of "${config.companyName}" to the right department.\n` +
    `Departments (id: description):\n` +
    deps.map((d) => `- ${d.id}: ${d.name} — ${d.description || ''}`).join('\n') +
    `\n\nChoose the single department that should handle the request. ` +
    `If the message is only a greeting or there is not enough information to decide, answer "unknown". ` +
    `Give a short reason in Hebrew.`;
  const user = `Customer: ${customerName || 'unknown'}\nMessages:\n` + texts.map((t) => `- ${t}`).join('\n');

  const c = getClient(config.ai.apiKey);
  let response;
  try {
    response = await c.beta.messages.create({
      model: config.ai.model || 'claude-opus-5-5',
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              department: { type: 'string', enum: [...ids, 'unknown'] },
              reason: { type: 'string' },
            },
            required: ['department', 'reason'],
            additionalProperties: false,
          },
        },
      },
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { departmentId: null, reason: 'מפתח ה-API של Claude לא תקין' };
    if (e instanceof Anthropic.RateLimitError) return { departmentId: null, reason: 'Claude עמוס כרגע' };
    if (e instanceof Anthropic.APIError) return { departmentId: null, reason: `שגיאת Claude ${e.status}` };
    return { departmentId: null, reason: 'אין חיבור ל-Claude' };
  }
  if (response.stop_reason === 'refusal') return { departmentId: null, reason: 'Claude סירב לסווג' };
  const block = response.content.find((b) => b.type === 'text');
  try {
    const parsed = JSON.parse(block ? block.text : '');
    const dep = ids.includes(parsed.department) ? parsed.department : null;
    return { departmentId: dep, reason: String(parsed.reason || '') };
  } catch {
    return { departmentId: null, reason: 'תשובה לא תקינה מ-Claude' };
  }
}

module.exports = { routeTicket };
