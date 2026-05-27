// netlify/functions/google-contacts.js

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const RESEND_KEY    = process.env.RESEND_API_KEY;

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── SEND EMAIL VIA RESEND ─────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'M2 Luxuries <onboarding@resend.dev>',
      to:   [to],
      subject,
      html
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Email failed: ' + JSON.stringify(data));
  console.log('✅ Email sent to:', to);
  return data;
}

function bookingEmailHTML(b, type) {
  const color = type === 'Booking' ? '#2563eb' : type === 'Consult' ? '#16a34a' : '#d97706';
  return `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9f9f9;padding:24px;border-radius:8px">
    <div style="background:#0a0a0a;padding:20px 24px;border-radius:6px 6px 0 0">
      <h1 style="color:#ffffff;font-size:22px;margin:0;letter-spacing:2px">M2 LUXURIES</h1>
      <p style="color:#888;font-size:12px;margin:4px 0 0;letter-spacing:1px">LAS COLINAS · IRVING TX</p>
    </div>
    <div style="background:#ffffff;padding:24px;border-radius:0 0 6px 6px;border:1px solid #e5e7eb">
      <div style="display:inline-block;background:${color};color:#fff;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:4px 12px;border-radius:20px;margin-bottom:16px">${type}</div>
      <h2 style="color:#0a0a0a;font-size:20px;margin:0 0 16px">${b.name}</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${b.service  ? `<tr><td style="padding:8px 0;color:#666;width:40%">Service</td><td style="padding:8px 0;color:#0a0a0a;font-weight:600">${b.service}</td></tr>` : ''}
        ${b.vehicle  ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Vehicle</td><td style="padding:8px 0;color:#0a0a0a;font-weight:600">${b.vehicle}</td></tr>` : ''}
        ${b.date     ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Date</td><td style="padding:8px 0;color:#0a0a0a;font-weight:600">${b.prettyDate}</td></tr>` : ''}
        ${b.time     ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Time</td><td style="padding:8px 0;color:#0a0a0a;font-weight:600">${b.prettyTime} Central</td></tr>` : ''}
        ${b.phone    ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Phone</td><td style="padding:8px 0;color:#0a0a0a;font-weight:600"><a href="tel:${b.phone}" style="color:#2563eb">${b.phone}</a></td></tr>` : ''}
        ${b.email    ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Email</td><td style="padding:8px 0;color:#0a0a0a;font-weight:600">${b.email}</td></tr>` : ''}
        ${b.notes    ? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Notes</td><td style="padding:8px 0;color:#0a0a0a">${b.notes}</td></tr>` : ''}
        ${b.interests? `<tr style="border-top:1px solid #f0f0f0"><td style="padding:8px 0;color:#666">Interested In</td><td style="padding:8px 0;color:#0a0a0a">${b.interests}</td></tr>` : ''}
      </table>
      <div style="margin-top:20px;padding:12px 16px;background:#f0fdf4;border-left:3px solid #16a34a;border-radius:4px;font-size:13px;color:#166534">
        <a href="https://m2crm.netlify.app" style="color:#166534;font-weight:700;text-decoration:none">→ View in CRM</a>
      </div>
    </div>
    <p style="text-align:center;color:#999;font-size:11px;margin-top:16px">M2 Luxuries · 3102 E Cortez Court, Irving TX 75062 · 972-245-1090</p>
  </div>`;
}

// ── FORMAT TIME ───────────────────────────────────────────────────────
function prettyTime(time24) {
  const [h, m] = time24.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  const hr = h % 12 || 12;
  return `${hr}:${String(m).padStart(2,'0')} ${ap}`;
}

function prettyDate(dateStr) {
  const [y,mo,d] = dateStr.split('-').map(Number);
  return new Date(y, mo-1, d).toLocaleDateString('en-US', {weekday:'long',month:'long',day:'numeric',year:'numeric'});
}

// ── CHECK CALENDAR AVAILABILITY ───────────────────────────────────────
async function checkCalendarAvailability(accessToken, date) {
  const timeMin = date + 'T00:00:00-05:00';
  const timeMax = date + 'T23:59:59-05:00';
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&timeZone=America/Chicago`;
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + accessToken } });
  if (!res.ok) { console.warn('Calendar check failed:', res.status); return []; }
  const data = await res.json();
  const busyHours = new Set();
  (data.items || []).forEach(event => {
    if (event.status === 'cancelled') return;
    if (event.start && event.start.date && !event.start.dateTime) { busyHours.add('ALL_DAY'); return; }
    if (event.start && event.start.dateTime) {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: false });
      const sp = fmt.formatToParts(new Date(event.start.dateTime));
      const ep = fmt.formatToParts(new Date(event.end.dateTime));
      const startHr = parseInt(sp.find(p => p.type === 'hour').value);
      const endMin  = parseInt(ep.find(p => p.type === 'minute').value);
      let   endHr   = parseInt(ep.find(p => p.type === 'hour').value);
      if (endMin > 0) endHr++;
      for (let h = startHr; h < endHr && h < 24; h++) busyHours.add(h);
      if (startHr <= 6 && endHr >= 18) busyHours.add('ALL_DAY');
    }
  });
  return Array.from(busyHours);
}

// ── CREATE CALENDAR EVENT ─────────────────────────────────────────────
async function createCalendarEvent(accessToken, b) {
  const durations = { 'M2 Refresh':2, 'M2 Signature':5, 'M2 Elite':8, 'Complimentary Consult':1 };
  const durationHrs = durations[b.service] || 2;
  const startISO = `${b.date}T${b.time}:00`;
  const endDT = new Date(new Date(startISO + '-05:00').getTime() + durationHrs * 3600000);
  const colors = { 'M2 Refresh':'10', 'M2 Signature':'9', 'M2 Elite':'11', 'Complimentary Consult':'5' };
  const event = {
    summary: `${b.service} — ${b.name}`,
    description: `📦 Service: ${b.service}\n🚗 Vehicle: ${b.vehicle||'Not specified'}\n📞 Phone: ${b.phone}\n📧 Email: ${b.email||'N/A'}\n📝 Notes: ${b.notes||'None'}\n\n🔗 https://m2crm.netlify.app`,
    start: { dateTime: startISO + '-05:00', timeZone: 'America/Chicago' },
    end:   { dateTime: endDT.toISOString(), timeZone: 'America/Chicago' },
    colorId: colors[b.service] || '10',
    reminders: { useDefault: false, overrides: [{ method:'popup', minutes:60 },{ method:'popup', minutes:1440 }] }
  };
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });
  if (!res.ok) throw new Error('Calendar event failed: ' + await res.text());
  return await res.json();
}

// ── CREATE CONTACT ────────────────────────────────────────────────────
async function createContact(accessToken, client) {
  const nameParts = client.name.trim().split(' ');
  const contact = {
    names:          [{ givenName: nameParts[0], familyName: nameParts.slice(1).join(' ') }],
    phoneNumbers:   client.phone ? [{ value: client.phone, type: 'mobile' }] : [],
    emailAddresses: client.email ? [{ value: client.email, type: 'home' }]   : [],
    biographies:    [{ value: 'M2 Luxuries Client' + (client.vehicle ? ' — ' + client.vehicle : '') + (client.notes ? ' | ' + client.notes : ''), contentType: 'TEXT_PLAIN' }]
  };
  const res = await fetch('https://people.googleapis.com/v1/people:createContact', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(contact)
  });
  if (!res.ok) throw new Error('Contact error: ' + await res.text());
  return await res.json();
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers, body:'' };
  if (event.httpMethod !== 'POST')   return { statusCode:405, headers, body:'Method not allowed' };

  try {
    const body = JSON.parse(event.body);
    const accessToken = await getAccessToken();

    // ── CHECK AVAILABILITY ──────────────────────────────────────────
    if (body.action === 'check_availability') {
      const busySlots = await checkCalendarAvailability(accessToken, body.date);
      return { statusCode:200, headers, body: JSON.stringify({ busySlots }) };
    }

    // ── BOOKING (Book Now button) ───────────────────────────────────
    if (body.action === 'create_booking') {
      const pd = prettyDate(body.date);
      const pt = prettyTime(body.time);
      const emailData = { ...body, prettyDate: pd, prettyTime: pt };

      // Email Moe
      try {
        await sendEmail(
          'mali@m2luxuries.com',
          `🚗 New ${body.service} — ${body.name}`,
          bookingEmailHTML(emailData, body.service === 'Complimentary Consult' ? 'Consult' : 'Booking')
        );
      } catch(e) { console.warn('Email to Moe failed:', e.message); }

      // Google Contact
      try { await createContact(accessToken, body); } catch(e) { console.warn('Contact failed:', e.message); }

      // Calendar event
      try { await createCalendarEvent(accessToken, body); } catch(e) { console.warn('Calendar failed:', e.message); }

      return { statusCode:200, headers, body: JSON.stringify({ success:true }) };
    }

    // ── QUOTE REQUEST ───────────────────────────────────────────────
    if (body.action === 'quote_request') {
      try {
        await sendEmail(
          'mali@m2luxuries.com',
          `💬 New Quote Request — ${body.name}`,
          bookingEmailHTML({ ...body, prettyDate:'', prettyTime:'' }, 'Quote')
        );
      } catch(e) { console.warn('Quote email failed:', e.message); }

      // Google Contact
      try { await createContact(accessToken, body); } catch(e) { console.warn('Contact failed:', e.message); }

      return { statusCode:200, headers, body: JSON.stringify({ success:true }) };
    }

    // ── CONTACT ONLY (from CRM) ─────────────────────────────────────
    if (body.name && !body.action) {
      const result = await createContact(accessToken, body);
      return { statusCode:200, headers, body: JSON.stringify({ success:true, resourceName: result.resourceName }) };
    }

    return { statusCode:400, headers, body:'Unknown action' };

  } catch(err) {
    console.error('Function error:', err.message);
    return { statusCode:500, headers, body: JSON.stringify({ success:false, error: err.message }) };
  }
};
