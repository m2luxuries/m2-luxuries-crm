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
  // Use full UTC day range to catch all events regardless of timezone
  const timeMin = date + 'T00:00:00Z';
  const timeMax = date + 'T23:59:59Z';

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;

  console.log('Checking calendar for date:', date);

  const res = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });

  if (!res.ok) {
    console.warn('Calendar check failed:', res.status, await res.text());
    return [];
  }

  const data = await res.json();
  console.log('Events found:', JSON.stringify(data.items?.map(e => ({
    summary: e.summary,
    start: e.start,
    end: e.end,
    status: e.status
  }))));

  const busyHours = new Set();

  (data.items || []).forEach(event => {
    if (event.status === 'cancelled') return;

    // All-day event (date only, no time)
    if (event.start && event.start.date && !event.start.dateTime) {
      busyHours.add('ALL_DAY');
      return;
    }

    if (event.start && event.start.dateTime) {
      const startDT = new Date(event.start.dateTime);
      const endDT   = new Date(event.end.dateTime);

      // Convert to Central time (UTC-5 CDT / UTC-6 CST)
      // Use getUTCHours and subtract offset
      const startUTC = startDT.getTime();
      const endUTC   = endDT.getTime();

      // Central offset: -5 hours (CDT, May = summer)
      const offsetMs = 5 * 60 * 60 * 1000;

      const startCentral = new Date(startUTC - offsetMs);
      const endCentral   = new Date(endUTC - offsetMs);

      const startHr = startCentral.getUTCHours();
      const endHr   = endCentral.getUTCHours() + (endCentral.getUTCMinutes() > 0 ? 1 : 0);

      console.log(`Event: "${event.summary}" — Central ${startHr}:00 to ${endHr}:00`);

      // Block all hours the event covers
      for (let h = startHr; h < endHr; h++) {
        busyHours.add(h);
      }

      // If event covers entire work day (6am-6pm or more), block all day
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
      console.log('Returning busy slots:', busySlots);
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
