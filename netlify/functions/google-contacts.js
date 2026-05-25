// netlify/functions/google-contacts.js
// Credentials stored securely in Netlify environment variables

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

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  try {
    const client = JSON.parse(event.body);
    if (!client || !client.name) {
      return { statusCode: 400, headers, body: 'Missing client data' };
    }

    const accessToken = await getAccessToken();

    const nameParts = client.name.trim().split(' ');
    const firstName = nameParts[0];
    const lastName  = nameParts.slice(1).join(' ');

    const contact = {
      names: [{ givenName: firstName, familyName: lastName }],
      phoneNumbers: client.phone ? [{ value: client.phone, type: 'mobile' }] : [],
      emailAddresses: client.email ? [{ value: client.email, type: 'home' }] : [],
      biographies: [{
        value: 'M2 Luxuries Client' +
          (client.vehicle ? ' — ' + client.vehicle : '') +
          (client.notes   ? ' | ' + client.notes   : ''),
        contentType: 'TEXT_PLAIN'
      }]
    };

    const gcRes = await fetch('https://people.googleapis.com/v1/people:createContact', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(contact)
    });

    if (!gcRes.ok) {
      const err = await gcRes.text();
      throw new Error('Google API error: ' + err);
    }

    const result = await gcRes.json();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, resourceName: result.resourceName })
    };

  } catch(err) {
    console.error('google-contacts function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
