/**
 * POST /api/lead — Cloudflare Pages Function.
 *
 * Upserts the lead into HubSpot, tags it with a recommended trail level,
 * drops a timeline note with their own words, opts them into the newsletter
 * list, and returns a personalized thank-you string for the page to render.
 *
 * Required env (Cloudflare Pages → Settings → Environment variables, encrypted):
 *   HUBSPOT_TOKEN               Private app token. Scopes: crm.objects.contacts.write,
 *                               crm.objects.contacts.read, crm.objects.notes.write,
 *                               crm.lists.write (only if using the list below).
 * Optional env:
 *   HUBSPOT_NEWSLETTER_LIST_ID  Static list id to add the contact to.
 *   NOTIFY_EMAIL                Currently unused; HubSpot workflow handles notification.
 */

const HS = 'https://api.hubapi.com';

const SIZE_LABEL = {
  '1-50': '1–50',
  '51-200': '51–200',
  '201-1000': '201–1,000',
  '1000+': '1,000+'
};

// Which trail to lead with, by company size — overridden by keyword signals below.
const SIZE_TRAIL = {
  '1-50': 'Green Trail',
  '51-200': 'Green Trail',
  '201-1000': 'Blue Trail',
  '1000+': 'Pro-Line'
};

const SIGNALS = [
  { trail: 'Team AI Training Workshop', re: /\b(train|training|upskill|enable|enablement|onboard|literacy|teach|workshop)\b/i },
  { trail: 'Pro-Line', re: /\b(policy|governance|advisor|fractional|retainer|leadership|board|compliance)\b/i },
  { trail: 'Blue Trail', re: /\b(workflow|automat|process|handoff|approval|manual|integrat|pipeline|ops)\b/i },
  { trail: 'Green Trail', re: /\b(where to start|not sure|don't know|assess|audit|readiness|evaluate|roadmap|strategy|storyboard)\b/i }
];

const TRAIL_LINE = {
  'Green Trail':
    'Based on what you wrote, we will likely start with a Green Trail — a scored read on where you stand, a phased roadmap, and dev-ready user stories.',
  'Team AI Training Workshop':
    'Based on what you wrote, our Team AI Training Workshop is probably the first turn — hands-on sessions taught against your own tools, standalone or bundled with a Green Trail roadmap.',
  'Blue Trail':
    'Based on what you wrote, this sounds like a Blue Trail — we take one workflow end-to-end into production, guardrailed and integrated, and you keep the source.',
  'Pro-Line':
    'Based on what you wrote, the Pro-Line fractional engagement may fit best — ongoing judgment as your team gets more ambitious.'
};

function recommendTrail(goal, size) {
  for (const s of SIGNALS) if (s.re.test(goal)) return s.trail;
  return SIZE_TRAIL[size] || 'Green Trail';
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });

async function hs(env, path, method, body) {
  const res = await fetch(HS + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }
  return { ok: res.ok, status: res.status, data };
}

export async function onRequestPost({ request, env }) {
  if (!env.HUBSPOT_TOKEN) return json({ error: 'Server not configured' }, 500);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'Bad request' }, 400); }

  // Honeypot — bots fill hidden fields.
  if (body.company_website) return json({ message: 'Thanks.' });

  const name = String(body.name || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const company = String(body.company || '').trim().slice(0, 160);
  const role = String(body.role || '').trim().slice(0, 120);
  const size = String(body.companySize || '').trim();
  const goal = String(body.goal || '').trim().slice(0, 4000);

  if (!name || !email || !company || !goal || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    return json({ error: 'Missing or invalid fields' }, 400);
  }

  const trail = recommendTrail(goal, size);
  const first = name.split(/\s+/)[0];
  const parts = name.split(/\s+/);

  // Only standard HubSpot properties, plus three custom ones you create once
  // (Settings → Properties → Contact): sbs_recommended_trail (single-line text),
  // sbs_commercialization_goal (multi-line text), sbs_newsletter_optin (single checkbox).
  const properties = {
    email,
    firstname: parts[0] || name,
    lastname: parts.slice(1).join(' ') || '—',
    company,
    jobtitle: role,
    numemployees: SIZE_LABEL[size] || size,
    hs_lead_status: 'NEW',
    lifecyclestage: 'lead',
    sbs_recommended_trail: trail,
    sbs_commercialization_goal: goal,
    sbs_newsletter_optin: 'true'
  };

  let contactId = null;
  const created = await hs(env, '/crm/v3/objects/contacts', 'POST', { properties });

  if (created.ok) {
    contactId = created.data && created.data.id;
  } else if (created.status === 409) {
    // Existing contact — the conflict message carries the id.
    const found = String((created.data && created.data.message) || '').match(/\d{3,}/);
    if (found) {
      contactId = found[0];
      await hs(env, `/crm/v3/objects/contacts/${contactId}`, 'PATCH', { properties });
    }
  }

  if (!contactId) {
    console.log('HubSpot contact failed', created.status, JSON.stringify(created.data));
    return json({ error: 'Could not record the lead' }, 502);
  }

  // Timeline note so the raw words are visible on the record, not just a property.
  await hs(env, '/crm/v3/objects/notes', 'POST', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body:
        `<p><strong>Trailmap Session request</strong> — recommended: ${trail}</p>` +
        `<p><strong>Company size:</strong> ${SIZE_LABEL[size] || size || 'not given'}<br>` +
        `<strong>Role:</strong> ${role || 'not given'}<br>` +
        `<strong>Source page:</strong> ${String(body.pageUri || '').slice(0, 300)}</p>` +
        `<p><strong>What they're trying to commercialize:</strong><br>${goal.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`
    },
    associations: [{
      to: { id: contactId },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
    }]
  });

  if (env.HUBSPOT_NEWSLETTER_LIST_ID) {
    await hs(env, `/crm/v3/lists/${env.HUBSPOT_NEWSLETTER_LIST_ID}/memberships/add`, 'PUT', [contactId]);
  }

  return json({
    ok: true,
    message: `Thanks, ${first}. ${TRAIL_LINE[trail]} Allen replies personally within one business day — ` +
             `you're also on the list for the monthly field notes, and you can unsubscribe from any of them.`
  });
}

export const onRequestGet = () => json({ error: 'Method not allowed' }, 405);
