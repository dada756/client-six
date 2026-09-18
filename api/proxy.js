import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseAdmin = (supabaseUrl && supabaseKey) 
    ? createClient(supabaseUrl, supabaseKey) 
    : null;

export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== "POST") {
        return res.status(405).json({
            error: "Method Not Allowed"
        });
    }

    try {
        const body = req.body;
        if (body.platform_name === "district") {
            const token = req.headers.authorization?.split('Bearer ')[1];
            if (!token) return res.status(401).json({
                error: 'Authentication required'
            });

            const {
                data: {
                    user
                },
                error: userError
            } = await supabaseAdmin.auth.getUser(token);
            if (userError || !user) return res.status(401).json({
                error: 'Invalid token'
            });

            // 3. Fetch the user's District profile data
            // ADD THIS:
const profile = {
    district_device_id: body.district_device_id,
    district_access_token: body.district_access_token,
    district_refresh_token: body.district_refresh_token,
    district_user_id: body.district_user_id,
    district_phone_number: body.district_phone_number
};
if (!profile.district_device_id) return res.status(400).json({ error: 'Missing District auth tokens in payload' });


            // --- NEW: Multi-Step 'district' Workflow ---

            // --- STEP 1: /checkout ---
            const checkoutUrl =
                "https://www.district.in/gw/consumer/movies/v2/checkout?version=3&site_id=1&channel=web&child_site_id=1&platform=district&native_withdraw=1";
            const checkoutPayload = {
                contentId: parseInt(body.content_id, 10),
                tempTransId: body.transaction_id,
                paymentDetails: [{
                    payment_method_id: "50",
                    payment_method_type: "upi_qr",
                    wallet_balance: "0.0",
                    wallet_id: "0"
                }],
            };
            const commonHeaders = { // Reusable headers for district.in
                'Cookie': `x-device-id=${profile.district_device_id}; x-access-token=${profile.district_access_token}; x-refresh-token=${profile.district_refresh_token};`,
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Api_source': 'district',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
                'Sec-Ch-Ua': '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
                'X-App-Type': 'ed_web',
                'Sec-Ch-Ua-Mobile': '?0',
                'Accept': '*/*',
                'Origin': 'https://www.district.in',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'cors',
                'Sec-Fetch-Dest': 'empty',
                'Referer': 'https://www.district.in/',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept-Language': 'en-US,en;q=0.9',
                'Priority': 'u=1, i'
            };

            const checkoutResponse = await fetch(checkoutUrl, {
                method: "POST",
                headers: {
                    ...commonHeaders,
                    "Content-Type": "application/json; charset=utf-8"
                },
                body: JSON.stringify(checkoutPayload),
            });
            const checkoutData = await checkoutResponse.json();
            if (!checkoutResponse.ok || checkoutData.status !== 'success') {
                throw {
                    step: 1,
                    message: "Checkout failed",
                    details: checkoutData
                };
            }

            const orderId = checkoutData.ORDER_ID;
            const hash = checkoutData.pgResponse?.hash;
            const grandTotal = checkoutData.pgResponse?.grandTotal;

            if (!orderId || !hash || !grandTotal) {
                throw {
                    step: 1,
                    message: "Missing critical data from checkout response",
                    details: checkoutData
                };
            }

            // --- STEP 2: /get-sdk-token ---
            const tokenUrl = "https://www.district.in/gw/payments/in/get-sdk-token?version=3&site_id=1&channel=web&child_site_id=1&platform=district";
            const tokenResponse = await fetch(tokenUrl, {
                method: "POST",
                headers: {
                    ...commonHeaders,
                    "Content-Length": "0"
                },
                body: null,
            });
            const tokenData = await tokenResponse.json();
            if (!tokenResponse.ok || !tokenData.token) {
                throw {
                    step: 2,
                    message: "Failed to get SDK token",
                    details: tokenData
                };
            }
            const sdkToken = tokenData.token;

            // --- STEP 3: /make_payment ---
            const paymentUrl = "https://zpay.zomato.com/v2/sdk/make_payment";
            const paymentPayload = new URLSearchParams({
                'host_redirect_url': `https://www.district.in/movies/order/${orderId}`,
                'service_type': 'ED_MOVIES',
                'user_id': profile.district_user_id,
                'order_type': 'ED_MOVIES',
                'order_id': orderId,
                'country_id': '1',
                'payment_method_id': '50',
                'payment_method_type': 'upi_qr',
                'amount': grandTotal,
                'payments_hash': hash,
                'phone': profile.district_phone_number,
                'isMobileView': '0'
            });

            const paymentResponse = await fetch(paymentUrl, {
                method: "POST",
                headers: {
                    'X-Consumer': 'zomato_pas_web_sdk',
                    'X-Pas-Token': sdkToken,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': 'https://www.district.in',
                    'Referer': 'https://www.district.in/',
                    /* other headers */
                },
                body: paymentPayload.toString(),
            });

            const paymentData = await paymentResponse.json();
            const qrImageBase64 = paymentData?.response?.transaction?.qr_data?.image;
            const expiryTime = paymentData?.response?.transaction?.qr_data?.expiry_time;

            if (!paymentResponse.ok || !qrImageBase64) {
                throw {
                    step: 3,
                    message: "Failed to make payment or get QR data",
                    details: paymentData
                };
            }

            // --- FINAL SUCCESS RESPONSE ---
            return res.status(200).json({
                success: true,
                qrImageBase64,
                expiryTime
            });

        } else {
            // --- EXISTING: Handle BookMyShow platform ---
            const formData = new FormData();
            formData.append("strAppCode", "WEB");
            formData.append("lngTransactionIdentifier", body.transaction_id);
            formData.append("strCommand", "SETPAYMENT");
            formData.append("strVenueCode", body.venue_code);
            formData.append("strParam1", "'|TYPE=UPI|UPITYPE=QRCODE|IMAGEURL=''|PROCESSTYPE=REQUEST|LSID=|MEMBERID=|CLIENTID=movies|");
            formData.append("strParam2", "|ETICKET=Y|MTICKET=Y|");
            formData.append("strParam3", body.email);
            formData.append("strParam4", body.phone);
            formData.append("strFormat", "json");
            const bmsResponse = await fetch("https://services-in.bookmyshow.com/doTrans.aspx", {
                method: "POST",
                headers: {
                    'Origin': 'https://in.bookmyshow.com',
                    'Referer': 'https://in.bookmyshow.com/',
                    'X-Region-Code': 'HYD',
                    'X-Region-Slug': 'hyderabad',
                    'X-Latitude': '17.385044',
                    'X-Longitude': '78.486671',
                    'X-Deemed-Email': body.email,
                    'X-Deemed-Mobile': body.phone,
                    'X-Phone': body.phone,
                    'X-Mobile': body.phone,
                    'X-Email': body.email,
                    'X-Transaction-Uid': body.trans_uid,
                    'X-App-Code': 'WEB',
                    'X-Platform-Code': 'WEB',
                    'X-Platform': 'WEB',
                    'Accept': 'application/json'
                },
                body: formData
            });
            const data = await bmsResponse.json();
            return res.status(200).json({
                success: true,
                BookMyShow: data.BookMyShow
            });
        }
    } catch (error) {
        console.error("Vercel Proxy Error:", error);
        res.status(500).json({
            success: false,
            error: 'Internal Server Error',
            details: error
        });
    }
}
