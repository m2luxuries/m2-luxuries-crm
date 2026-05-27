// netlify/functions/google-contacts.js

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

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

// ── CHECK CALENDAR AVAILABILITY ──────────────────────────────────────
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
      const startDT = new Date(event.start.dateTime);
      const endDT   = new Date(event.end.dateTime);
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: 'numeric', hour12: false });
      const sp = fmt.formatToParts(startDT); const ep = fmt.formatToParts(endDT);
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
async function createCalendarEvent(accessToken, booking) {
  // Figure out end time based on package
  const durations = {
    'M2 Refresh':   2,  // 2 hours
    'M2 Signature': 5,  // 5 hours
    'M2 Elite':     8,  // 8 hours
    'Complimentary Consult': 1  // 1 hour
  };
  const durationHrs = durations[booking.service] || 2;

  // Parse date and time into a proper datetime
  // date = 'YYYY-MM-DD', time = 'HH:MM' (24hr)
  const startISO = `${booking.date}T${booking.time}:00`;
  const startDT  = new Date(startISO + '-05:00'); // Central time
  const endDT    = new Date(startDT.getTime() + durationHrs * 60 * 60 * 1000);

  const pad = n => String(n).padStart(2, '0');
  const fmtLocal = dt => {
    // Format as local Central time ISO string
    const y = dt.getUTCFullYear();
    const mo = pad(dt.getUTCMonth() + 1);
    const d  = pad(dt.getUTCDate());
    const h  = pad(dt.getUTCHours());
    const mi = pad(dt.getUTCMinutes());
    return `${y}-${mo}-${d}T${h}:${mi}:00`;
  };

  // Build event description
  const lines = [
    `📦 Service: ${booking.service}`,
    `🚗 Vehicle: ${booking.vehicle || 'Not specified'}`,
    `📞 Phone: ${booking.phone}`,
    `📧 Email: ${booking.email || 'Not provided'}`,
    booking.notes ? `📝 Notes: ${booking.notes}` : '',
    ``,
    `💳 $25 deposit paid via Stripe`,
    `🔗 View in CRM: https://m2crm.netlify.app`
  ].filter(Boolean).join('\n');

  const event = {
    summary: `${booking.service} — ${booking.name}`,
    description: lines,
    start: {
      dateTime: startISO + '-05:00',
      timeZone: 'America/Chicago'
    },
    end: {
      dateTime: new Date(new Date(startISO + '-05:00').getTime() + durationHrs * 60 * 60 * 1000).toISOString(),
      timeZone: 'America/Chicago'
    },
    colorId: booking.service === 'Complimentary Consult' ? '5' :  // banana yellow
              booking.service === 'M2 Elite' ? '11' :              // tomato red
              booking.service === 'M2 Signature' ? '9' :           // blueberry
              '10',                                                 // sage green (Refresh)
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },   // 1 hour before
        { method: 'popup', minutes: 1440 }  // 1 day before
      ]
    }
  };

  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(event)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('Calendar event creation failed: ' + err);
  }

  const result = await res.json();
  console.log('✅ Calendar event created:', result.id, result.summary);
  return result;
}

// ── CREATE GOOGLE CONTACT ─────────────────────────────────────────────
async function createContact(accessToken, client) {
  const nameParts = client.name.trim().split(' ');
  const contact = {
    names:          [{ givenName: nameParts[0], familyName: nameParts.slice(1).join(' ') }],
    phoneNumbers:   client.phone ? [{ value: client.phone, type: 'mobile' }] : [],
    emailAddresses: client.email ? [{ value: client.email, type: 'home' }]   : [],
    biographies:    [{
      value: 'M2 Luxuries Client' +
        (client.vehicle ? ' — ' + client.vehicle : '') +
        (client.notes   ? ' | ' + client.notes   : ''),
      contentType: 'TEXT_PLAIN'
    }]
  };

  const res = await fetch('https://people.googleapis.com/v1/people:createContact', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(contact)
  });

  if (!res.ok) throw new Error('Google Contacts error: ' + await res.text());
  return await res.json();
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────
exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: 'Method not allowed' };

  try {
    const body = JSON.parse(event.body);
    const accessToken = await getAccessToken();

    // ── CHECK AVAILABILITY ────────────────────────────────────────
    if (body.action === 'check_availability') {
      const busySlots = await checkCalendarAvailability(accessToken, body.date);
      return { statusCode: 200, headers, body: JSON.stringify({ busySlots }) };
    }

    // ── CREATE BOOKING (contact + calendar event) ─────────────────
    if (body.action === 'create_booking') {
      const results = {};

      // Create Google Contact
      try {
        results.contact = await createContact(accessToken, body);
        console.log('✅ Contact created for:', body.name);
      } catch(e) {
        console.warn('Contact creation failed (non-blocking):', e.message);
      }

      // Create Calendar Event
      try {
        results.event = await createCalendarEvent(accessToken, body);
        console.log('✅ Calendar event created for:', body.name);
      } catch(e) {
        console.warn('Calendar event failed (non-blocking):', e.message);
        results.calendarError = e.message;
      }

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...results }) };
    }

    // ── CREATE CONTACT ONLY (from CRM) ────────────────────────────
    if (body.name && !body.action) {
      const result = await createContact(accessToken, body);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, resourceName: result.resourceName }) };
    }

    return { statusCode: 400, headers, body: 'Unknown action' };

  } catch(err) {
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
