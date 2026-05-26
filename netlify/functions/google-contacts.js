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

async function checkCalendarAvailability(accessToken, date) {
  // Query in Central time (America/Chicago) to avoid cross-day bleed
  // CDT = UTC-5 (March-Nov), CST = UTC-6 (Nov-March)
  // May = CDT = UTC-5
  const timeMin = date + 'T00:00:00-05:00';
  const timeMax = date + 'T23:59:59-05:00';

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&timeZone=America/Chicago`;

  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + accessToken } });

  if (!res.ok) {
    console.warn('Calendar check failed:', res.status, await res.text());
    return [];
  }

  const data = await res.json();
  const busyHours = new Set();

  (data.items || []).forEach(event => {
    if (event.status === 'cancelled') return;

    // All-day event
    if (event.start && event.start.date && !event.start.dateTime) {
      busyHours.add('ALL_DAY');
      return;
    }

    if (event.start && event.start.dateTime) {
      // Parse the dateTime string directly — Google returns it in the event's timezone
      // e.g. "2026-05-27T06:00:00-05:00"
      const startStr = event.start.dateTime;
      const endStr   = event.end.dateTime;

      // Extract just the local time part (HH:MM) regardless of timezone suffix
      // by converting to Central time using Intl
      const startDT = new Date(startStr);
      const endDT   = new Date(endStr);

      // Get hours in Central time
      const centralFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      });

      const startParts = centralFormatter.formatToParts(startDT);
      const endParts   = centralFormatter.formatToParts(endDT);

      const startHr = parseInt(startParts.find(p => p.type === 'hour').value);
      const endMin  = parseInt(endParts.find(p => p.type === 'minute').value);
      let   endHr   = parseInt(endParts.find(p => p.type === 'hour').value);
      if (endMin > 0) endHr++; // round up

      console.log(`Event: "${event.summary}" — Central ${startHr}:00 to ${endHr}:00`);

      // Block all hours this event covers
      for (let h = startHr; h < endHr && h < 24; h++) {
        busyHours.add(h);
      }

      // If covers whole work day
      if (startHr <= 6 && endHr >= 18) {
        busyHours.add('ALL_DAY');
      }
    }
  });

  return Array.from(busyHours);
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
      console.log('Busy slots for', body.date, ':', busySlots);
      return { statusCode: 200, headers, body: JSON.stringify({ busySlots }) };
    }

    // ── CREATE CONTACT ─────────────────────────────────────────────
    if (body.name) {
      const client = body;
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
    console.error('Function error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
