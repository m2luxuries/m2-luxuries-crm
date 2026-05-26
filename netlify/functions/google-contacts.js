// netlify/functions/google-contacts.js
// Handles Google Contacts creation + Calendar availability checking

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

async function checkCalendarAvailability(accessToken, date) {
  // Check Google Calendar for busy slots on the given date (YYYY-MM-DD)
  const start = date + 'T00:00:00-06:00'; // Central time
  const end   = date + 'T23:59:59-06:00';

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(start)}&timeMax=${encodeURIComponent(end)}&singleEvents=true&orderBy=startTime`,
    { headers: { 'Authorization': 'Bearer ' + accessToken } }
  );

  if (!res.ok) {
    console.warn('Calendar check failed:', await res.text());
    return []; // fail open — don't block booking if calendar check fails
  }

  const data = await res.json();
  const busySlots = [];

  (data.items || []).forEach(event => {
    if (event.status === 'cancelled') return;
    // All-day event = block entire day
    if (event.start && event.start.date && !event.start.dateTime) {
      busySlots.push('ALL_DAY');
      return;
    }
    // Timed event — figure out which hours it covers
    if (event.start && event.start.dateTime) {
      const startHr = new Date(event.start.dateTime).getHours();
      const endHr   = Math.ceil(new Date(event.end.dateTime).getHours() + new Date(event.end.dateTime).getMinutes() / 60);
      for (let h = startHr; h < endHr; h++) busySlots.push(h);
    }
  });

  return busySlots;
}

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

    // ── CHECK AVAILABILITY ─────────────────────────────────────────
    if (body.action === 'check_availability') {
      const busySlots = await checkCalendarAvailability(accessToken, body.date);
      return { statusCode: 200, headers, body: JSON.stringify({ busySlots }) };
    }

    // ── CREATE CONTACT ─────────────────────────────────────────────
    if (body.action === 'create_contact' || body.name) {
      const client = body;
      if (!client.name) return { statusCode: 400, headers, body: 'Missing name' };

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

      const gcRes = await fetch('https://people.googleapis.com/v1/people:createContact', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(contact)
      });

      if (!gcRes.ok) throw new Error('Google Contacts error: ' + await gcRes.text());
      const result = await gcRes.json();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, resourceName: result.resourceName }) };
    }

    return { statusCode: 400, headers, body: 'Unknown action' };

  } catch(err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
