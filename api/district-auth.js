import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseAdmin = (supabaseUrl && supabaseKey) 
    ? createClient(supabaseUrl, supabaseKey) 
    : null;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {

    const { action, ...payload } = req.body;

    // --- Authenticate the user for every action ---
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    // --- Action Router ---
    switch (action) {
      case 'generate-otp':
        return await handleGenerateOtp(user, payload, res);
      case 'validate-otp':
        return await handleValidateOtp(user, payload, res);
      case 'logout':
        return await handleLogout(user, res);
      default:
        return res.status(400).json({ error: 'Invalid action.' });
    }
  } catch (error) {
    console.error('District Auth API Error:', error.message);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}

async function handleGenerateOtp(user, payload, res) {
  const { phone_number } = payload;
  const deviceId = crypto.randomUUID();
  const guestToken = Math.floor(100000000 + Math.random() * 900000000).toString(); // Random 9-digit int

  const response = await fetch('https://www.district.in/gw/auth/generate_otp', {
    method: 'POST',
    headers: {
      'Host': 'www.district.in',
      'Cookie': `x-device-id=${deviceId}`,
      'X-Guest-Token': guestToken,
      'Content-Type': 'application/json',
      'X-Client-Id': 'district-web',
      'X-App-Type': 'ed_web',
      'Origin': 'https://www.district.in',
      'Referer': 'https://www.district.in/',
      'Accept': '*/*',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    body: JSON.stringify({ phone_number, country_code: "91" }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    return res.status(response.status).json({ error: 'Failed to generate OTP.', details: errorData });
  }

  // Persist the deviceId to the user's profile
  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update({ district_device_id: deviceId })
    .eq('id', user.id);

  if (updateError) {
    throw new Error('Failed to save deviceId to profile.');
  }

  // Return the temporary guest token to the frontend
  return res.status(200).json({ success: true, guestToken });
}

async function handleValidateOtp(user, payload, res) {
  const { phone_number, otp, guestToken } = payload;

  // Fetch the persisted deviceId
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('district_device_id')
    .eq('id', user.id)
    .single();
  
  if (profileError || !profile || !profile.district_device_id) {
    throw new Error('Could not find deviceId for user.');
  }

  const response = await fetch('https://www.district.in/gw/auth/validate_otp', {
    method: 'POST',
    headers: {
      'Cookie': `x-device-id=${profile.district_device_id}`,
      'X-Guest-Token': guestToken,
      'Content-Type': 'application/json',
      'X-Client-Id': 'district-web',
      'X-App-Type': 'ed_web', 'Origin': 'https://www.district.in', 'Referer': 'https://www.district.in/',
    },
    body: JSON.stringify({ phone_number, otp, country_code: "91" }),
  });
  
  const data = await response.json();

  if (!response.ok || data.status?.status === 'STATUS_FAILURE') {
    return res.status(400).json({ error: data.status.message || 'Invalid OTP.' });
  }

  // On success, extract tokens and update the user's profile
  const { token, user: districtUser } = data;
  const updatePayload = {
    district_access_token: token.access_token,
    district_refresh_token: token.refresh_token,
    district_user_id: districtUser.id,
    district_user_name: districtUser.name,
    district_phone_number: districtUser.phone_number,
    district_synced_at: new Date().toISOString(),
  };

  const { error: updateError } = await supabaseAdmin
    .from('profiles')
    .update(updatePayload)
    .eq('id', user.id);
  
  if (updateError) {
    throw new Error('Failed to save District tokens to profile.');
  }

  return res.status(200).json({ success: true });
}

async function handleLogout(user, res) {
  const { error } = await supabaseAdmin
    .from('profiles')
    .update({
      district_device_id: null,
      district_access_token: null,
      district_refresh_token: null,
      district_user_id: null,
      district_user_name: null,
      district_phone_number: null,
      district_synced_at: null,
    })
    .eq('id', user.id);

  if (error) {
    throw new Error('Failed to clear District data from profile.');
  }

  return res.status(200).json({ success: true });
}
