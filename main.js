import { createClient } from "@supabase/supabase-js";

// --- CONFIGURATION ---
const SUPABASE_URL = "https://edqxafyqqkhxuipzcjcd.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkcXhhZnlxcWtoeHVpcHpjamNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyOTYzNzIsImV4cCI6MjEwMjg3MjM3Mn0.dAerrc1sTh8CSnY6vZ4NtuvPXWNwjsHCl9gWZ436MLk";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- GLOBAL STATE ---
const ticketRegistry = new Map();
let userState = { session: null, profile: null, isDistrictLinked: false };
let tempAuthState = { guestToken: null, phoneNumber: null };
const LOCK_LIFETIME_MS = 5 * 60 * 1000;
let localClaims = JSON.parse(localStorage.getItem("snipe_claims") || "{}");
let currentSelectedTicket = null;

// --- DOM Elements ---
// Main App
const btnCopyKeys = document.getElementById('btn-copy-keys');
const listEl = document.getElementById("ticket-list");
const selectedTicketEl = document.getElementById("selected-ticket");
const btnGenerate = document.getElementById("btn-generate");
const inputPhone = document.getElementById("user-phone");
const inputEmail = document.getElementById("user-email");
const statusMsg = document.getElementById("status-msg");
const qrContainer = document.getElementById("qr-container");
const commandConsole = document.querySelector(".command-console");
const statusDot = document.querySelector(".dot");
const statusText = document.getElementById("status-text");
const commandPanel = document.querySelector(".command-panel");
const collapsibleSection = document.querySelector(".collapsible-section");
// Auth Modal
const btnShowLoginModal = document.getElementById('btn-show-login-modal');
const modalOverlay = document.getElementById('auth-modal-overlay');
const btnCloseModal = document.getElementById('btn-close-modal');
const modalViews = document.querySelectorAll('.modal-view');
const modalStatusMsg = document.getElementById('modal-status-msg');
// Modal Forms & Views
const formLoginRegister = document.getElementById('form-login-register');
const formPhone = document.getElementById('form-phone');
const formOtp = document.getElementById('form-otp');
const viewLoggedIn = document.getElementById('view-logged-in');
const viewShowKeys = document.getElementById('view-show-keys');
const loggedInEmailEl = document.getElementById('logged-in-email');
const districtSyncStatusEl = document.getElementById('district-sync-status');
const btnLogout = document.getElementById('btn-logout');
const btnCloseKeysView = document.getElementById('btn-close-keys-view');

// --- INITIALIZATION ---
async function init() {
    // Standard app init
    setupInputListeners();
    document.getElementById("btn-close-panel").addEventListener("click", () => commandPanel.classList.remove("panel-open"));
    cleanExpiredLocalClaims();
    fetchAndRenderInitialTickets();
    subscribeToRealtimeTickets();
    setInterval(sweepExpiredTickets, 1000);

    // Auth init
    setupAuthListeners();
    supabase.auth.onAuthStateChange((_event, session) => {
        handleAuthStateChange(session);
    });
    setupFeedDelegation();
}

// --- AUTHENTICATION LOGIC ---
function setupAuthListeners() {
    btnShowLoginModal.addEventListener('click', openModal);
    btnCloseModal.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) closeModal();
    });
    formLoginRegister.addEventListener('submit', handleLoginRegister);
    formPhone.addEventListener('submit', handleGenerateOtp);
    formOtp.addEventListener('submit', handleValidateOtp);
    btnLogout.addEventListener('click', handleLogout);
    btnCloseKeysView.addEventListener('click', () => showModalView('view-logged-in'));
    btnCopyKeys.addEventListener('click', () => {
        const snippetText = document.getElementById('config-snippet').innerText;
        navigator.clipboard.writeText(snippetText).then(() => {
            const originalText = btnCopyKeys.innerText;
            btnCopyKeys.innerText = "Copied!";
            btnCopyKeys.style.color = "var(--status-green)";
            btnCopyKeys.style.borderColor = "var(--status-green)";
            
            setTimeout(() => {
                btnCopyKeys.innerText = originalText;
                btnCopyKeys.style.color = "";
                btnCopyKeys.style.borderColor = "";
            }, 2000);
        });
    });
}

function setupFeedDelegation() {
    listEl.addEventListener("click", (e) => {
        const item = e.target.closest(".ticket-item");
        if (!item) return;
        const tid = item.getAttribute("data-tid");
        const ticketData = ticketRegistry.get(tid);
        if (ticketData) {
            document.querySelectorAll(".ticket-item").forEach((el) => el.classList.remove("active"));
            item.classList.add("active");
            selectTicket(ticketData.rawTicket);
            commandPanel.classList.add("panel-open");
        }
    });
}
async function handleAuthStateChange(session) {
    if (session) {
        // 1. Verify the cached session against the live database
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        
        // 2. If the user was deleted on the backend, force a local sign-out
        if (userError || !user) {
            await supabase.auth.signOut();
            return;
        }

        userState.session = session;
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .single();

        if (profile) {
            userState.profile = profile;
            if (profile.district_synced_at) {
                const syncDate = new Date(profile.district_synced_at);
                const expiryDate = new Date(syncDate.setDate(syncDate.getDate() + 29));
                userState.isDistrictLinked = new Date() < expiryDate;
            } else {
                userState.isDistrictLinked = false;
            }
        }
    } else {
        userState = { session: null, profile: null, isDistrictLinked: false };
    }
    updateUiForAuthState();
}

async function handleLoginRegister(e) {
    e.preventDefault();
    setModalStatus("Processing...", "var(--text-muted)");
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
        if (signInError.message.includes("Invalid login credentials")) {
            const { error: signUpError } = await supabase.auth.signUp({ email, password });
            if (signUpError) {
                setModalStatus(signUpError.message, "var(--status-red)");
            } else {
                setModalStatus("");
            }
        } else {
            setModalStatus(signInError.message, "var(--status-red)");
        }
    } else {
        setModalStatus("");
    }
}

async function handleGenerateOtp(e) {
    e.preventDefault();
    setModalStatus("Sending OTP...", "var(--text-muted)");
    const phoneNumber = document.getElementById('district-phone').value;
    tempAuthState.phoneNumber = phoneNumber;
    
    const { data, error } = await callAuthApi('generate-otp', { phone_number: phoneNumber });

    if (error) {
        setModalStatus(error.message || 'An error occurred.', "var(--status-red)");
    } else {
        tempAuthState.guestToken = data.guestToken;
        document.getElementById('otp-phone-display').innerText = phoneNumber;
        showModalView('view-integrate-otp');
        setModalStatus("");
    }
}

async function handleValidateOtp(e) {
    e.preventDefault();
    setModalStatus("Verifying OTP...", "var(--text-muted)");
    const otp = document.getElementById('district-otp').value;

    const { error } = await callAuthApi('validate-otp', {
        phone_number: tempAuthState.phoneNumber,
        otp: otp,
        guestToken: tempAuthState.guestToken,
    });
    
    if (error) {
        setModalStatus(error.message || 'Verification failed.', "var(--status-red)");
    } else {
        await handleAuthStateChange(userState.session); 
        displayConfigKeys();
        showModalView('view-show-keys');
        setModalStatus("");
    }
}

async function handleLogout() {
    await callAuthApi('logout', {});
    await supabase.auth.signOut();
    closeModal();
}

async function callAuthApi(action, payload) {
    try {
        const response = await fetch('/api/district-auth', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${userState.session.access_token}`
            },
            body: JSON.stringify({ action, ...payload })
        });
        
        // 1. Get raw text first to prevent JSON parse errors from masking the issue
        const text = await response.text();
        
        let data;
        try {
            data = JSON.parse(text);
        } catch (err) {
            data = text; // If it's HTML/text, just keep the raw string
        }

        if (!response.ok) {
            // 2. Inject the status code and the full stringified response payload
            const detailedError = typeof data === 'object' ? JSON.stringify(data) : data;
            return { data: null, error: { message: `HTTP ${response.status} | Payload: ${detailedError}` } };
        }
        
        return { data, error: null };
    } catch (e) {
        // 3. Catch true network failures (e.g., CORS, DNS) instead of hardcoding the string
        return { data: null, error: { message: `Client Exception: ${e.message}` } };
    }
}

// --- MODAL UI & STATE MANAGEMENT ---
function openModal() {
    updateUiForAuthState();
    modalOverlay.style.display = 'flex';
}
function closeModal() {
    modalOverlay.style.display = 'none';
    setModalStatus("");
}
function showModalView(viewId) {
    modalViews.forEach(view => view.style.display = 'none');
    document.getElementById(viewId).style.display = 'block';
}
function setModalStatus(text, color = 'var(--text-main)') {
    modalStatusMsg.innerText = text;
    modalStatusMsg.style.color = color;
}

function updateUiForAuthState() {
    if (userState.session) {
        loggedInEmailEl.innerText = userState.session.user.email;
        let syncHtml = '';
        if (userState.isDistrictLinked) {
            syncHtml = `<p>District Account: <strong class="status-synced">SYNCED</strong><br>User ID: <strong>${userState.profile.district_user_id}</strong></p>`;
        } else {
            syncHtml = `<p>District Account: <strong class="status-not-synced">NOT SYNCED</strong></p><button id="btn-start-sync" class="btn-primary">Sync Now</button>`;
        }
        districtSyncStatusEl.innerHTML = syncHtml;
        showModalView('view-logged-in');
        const btnStartSync = document.getElementById('btn-start-sync');
        if(btnStartSync) btnStartSync.addEventListener('click', () => showModalView('view-integrate-phone'));
    } else {
        showModalView('view-login-register');
    }
}

function displayConfigKeys() {
    const { profile } = userState;
    if (!profile) return;
    const snippet = `DEVICE_ID = "${profile.district_device_id}"\nACCESS_TOKEN = "${profile.district_access_token}"\nREFRESH_TOKEN = "${profile.district_refresh_token}"`;
    document.getElementById('config-snippet').innerText = snippet;
}

// --- CORE TICKET SNIPING LOGIC ---
function setupInputListeners() {
    inputPhone.addEventListener("input", (e) => localStorage.setItem("snipe_phone", e.target.value.trim()));
    inputEmail.addEventListener("input", (e) => localStorage.setItem("snipe_email", e.target.value.trim()));
}

function cleanExpiredLocalClaims() {
    const now = Date.now();
    for (const tid in localClaims) {
        const claim = localClaims[tid];
        const expireTime = claim.expiresAt || (claim.claimedAt + LOCK_LIFETIME_MS);
        if (now >= expireTime) delete localClaims[tid];
    }
    localStorage.setItem("snipe_claims", JSON.stringify(localClaims));
}

async function fetchAndRenderInitialTickets() {
    const nowMs = Date.now();
    const maxDistrictSec = Math.floor(nowMs / 1000) - 480;
    const maxBmsMs = nowMs - 300000;
    const claimTids = Object.keys(localClaims);
    
    // Construct the smart OR query
    let orQuery = `and(platform_name.eq.district,status.eq.AVAILABLE,snipe_timestamp.gte.${maxDistrictSec}),and(platform_name.is.null,status.eq.AVAILABLE,snipe_timestamp.gte.${maxBmsMs})`;
    
    if (claimTids.length > 0) {
         orQuery += `,transaction_id.in.(${claimTids.join(",")})`;
    }
    
    const { data: tickets, error } = await supabase
        .from("tickets")
        .select("*")
        .or(orQuery)
        .order("snipe_timestamp", { ascending: false });

    if (error) {
        setStatus("OFFLINE", "var(--status-red)");
    } else if (tickets && tickets.length > 0) {
        tickets.forEach((ticket) => {
            const maxLifetimeMs = (ticket.platform_name === "district" ? 480 : 300) * 1000;
            // Normalize on the fly
            const normalizedTs = ticket.snipe_timestamp > 100000000000 ? ticket.snipe_timestamp : ticket.snipe_timestamp * 1000;
            
            if ((Date.now() - normalizedTs <= maxLifetimeMs) || localClaims[ticket.transaction_id]) {
                addTicketToUI(ticket, false);
            }
        });
    }
}

function subscribeToRealtimeTickets() {
    supabase.channel("public-tickets-feed").on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, (payload) => {
        if (payload.eventType === "INSERT" && payload.new.status === "AVAILABLE") {
            const maxLifetimeMs = payload.new.platform_name === "district" ? 480 * 1000 : 300 * 1000;
            const normalizedTs = payload.new.snipe_timestamp > 100000000000 ? payload.new.snipe_timestamp : payload.new.snipe_timestamp * 1000;
            if (Date.now() - normalizedTs <= maxLifetimeMs) {
                addTicketToUI(payload.new, true);
            }
        } else if (payload.eventType === "UPDATE" && payload.new.status === "CLAIMED") {
            const tid = payload.new.transaction_id;
            if (!localClaims[tid]) {
                const registryItem = ticketRegistry.get(tid);
if (registryItem) {
    registryItem.element.remove();
    ticketRegistry.delete(tid);
}
                if (currentSelectedTicket && currentSelectedTicket.transaction_id === tid) {
                    clearCheckoutPanel();
                }
            }
        }
    }).subscribe((status) => {
        if (status === "SUBSCRIBED") setStatus("LIVE", "var(--status-green)");
        else setStatus("RECONNECTING", "var(--status-amber)");
    });
}

function setStatus(text, color) {
    statusText.innerText = text;
    statusDot.style.background = color;
}

function addTicketToUI(ticket, prepend = false) {
    const li = document.createElement("li");
    li.className = "ticket-item";
    li.setAttribute("data-timestamp", ticket.snipe_timestamp);
    li.setAttribute("data-tid", ticket.transaction_id);
    li.setAttribute("data-platform", ticket.platform_name || "");
    if (localClaims[ticket.transaction_id]) {
        li.classList.add("claimed-ticket");
    }
    li.innerHTML = `<div class="t-main"><div class="t-header"><span>${ticket.attributes || "Screen unlisted"}</span><span>${ticket.show_date_code} • ${ticket.show_time}</span></div><div class="t-movie-title">${ticket.event_title || "Unknown title"}</div><div class="t-headers"><span>${ticket.event_language} • ${ticket.event_dimension}${ticket.seating_class ? " • " + ticket.seating_class : ""}</span></div></div><div class="t-stub"><span class="notch notch-top"></span><span class="notch notch-bottom"></span><div class="stub-seat">${ticket.seat}</div></div><div class="timer-track"><div class="timer-bar"></div></div>`;
    const platform = ticket.platform_name || "";
const rawTs = parseInt(ticket.snipe_timestamp);
const normalizedTs = rawTs > 100000000000 ? rawTs : rawTs * 1000;
const totalDurationMs = (platform === "district" ? 480 : 300) * 1000;

ticketRegistry.set(ticket.transaction_id, {
    transactionId: ticket.transaction_id,
    element: li,
    timerBar: li.querySelector(".timer-bar"),
    normalizedTs: normalizedTs,
    totalDurationMs: totalDurationMs,
    platform: platform,
    rawTicket: ticket
});
    if (prepend) {
        listEl.prepend(li);
        li.animate([{ borderColor: "var(--status-green)" }, { borderColor: "var(--border-muted)" }], { duration: 1500 });
    } else {
        listEl.appendChild(li);
    }
}

function selectTicket(ticket) {
    currentSelectedTicket = ticket;
    selectedTicketEl.classList.remove("empty-state");
    selectedTicketEl.innerHTML = `<div class="t-main"><div class="t-header"><span>${ticket.attributes || "Screen unlisted"}</span><span>${ticket.show_date_code} • ${ticket.show_time}</span></div><div class="t-movie-title">${ticket.event_title}</div><div class="t-headers"><span>${ticket.event_language} • ${ticket.event_dimension}${ticket.seating_class ? " • " + ticket.seating_class : ""}</span></div></div><div class="t-stub"><span class="notch notch-top"></span><span class="notch notch-bottom"></span><div class="stub-seat">${ticket.seat}</div></div>`;
    
    if (localClaims[ticket.transaction_id]) {
        collapsibleSection.classList.remove("do-animate");
        commandConsole.classList.add("claimed-mode");
        inputPhone.disabled = true;
        inputEmail.disabled = true;
        btnGenerate.disabled = true;
        statusMsg.style.color = "var(--status-green)";
        const claimData = localClaims[ticket.transaction_id];
        
        if (claimData.qrImageBase64) {
            const qrImgDataUri = "data:image/png;base64," + claimData.qrImageBase64;
            qrContainer.innerHTML = `<div class="qr-wrapper"><img id="qr-result" src="${qrImgDataUri}" alt="Payment QR" /></div><p class="qr-instruction">Scan with any UPI app to lock this seat</p>`;
            statusMsg.innerText = "Seat claimed. QR image valid for 5 minutes.";
        } else if (claimData.qrUrl) { // Fallback for old BMS flow
            qrContainer.innerHTML = `<div class="qr-wrapper"><img id="qr-result" src="${claimData.qrUrl}" alt="Payment QR" /></div><p class="qr-instruction">Scan with any UPI app to lock this seat</p>`;
            statusMsg.innerText = "Seat claimed. QR image valid for 5 minutes.";
        }
        qrContainer.style.display = "flex";
    } else {
        commandConsole.classList.remove("claimed-mode");
        
        // Hide inputs for District, show them for BookMyShow
        if (ticket.platform_name === 'district') {
            document.querySelector('.user-data-grid').style.display = 'none';
            inputPhone.disabled = true;
            inputEmail.disabled = true;
        } else {
            document.querySelector('.user-data-grid').style.display = 'grid';
            inputPhone.disabled = false;
            inputEmail.disabled = false;
        }

        btnGenerate.disabled = false;
        statusMsg.innerText = "";
        qrContainer.style.display = "none";
    }
}

function clearCheckoutPanel() {
    currentSelectedTicket = null;
    collapsibleSection.classList.remove("do-animate");
    selectedTicketEl.classList.add("empty-state");
    selectedTicketEl.innerHTML = `<p style="color:var(--status-red);">This seat expired — pick another.</p>`;
    document.querySelector('.user-data-grid').style.display = 'grid';
    inputPhone.disabled = true;
    inputEmail.disabled = true;
    btnGenerate.disabled = true;
    qrContainer.style.display = "none";
    statusMsg.innerText = "";
    commandConsole.classList.remove("claimed-mode");
    document.querySelectorAll(".ticket-item").forEach((el) => el.classList.remove("active"));
}

function sweepExpiredTickets() {
    const now = Date.now();
    let claimsChanged = false;

    for (const [tid, data] of ticketRegistry.entries()) {
        const claimData = localClaims[tid];
        let totalDurationMs;
        let timeRemainingMs;

        if (claimData) {
            if (claimData.expiresAt) {
                totalDurationMs = claimData.expiresAt - claimData.claimedAt;
                timeRemainingMs = claimData.expiresAt - now;
            } else {
                totalDurationMs = LOCK_LIFETIME_MS;
                timeRemainingMs = totalDurationMs - (now - claimData.claimedAt);
            }
        } else {
            totalDurationMs = data.totalDurationMs;
            timeRemainingMs = (data.normalizedTs + totalDurationMs) - now;
        }

        if (timeRemainingMs <= 0) {
            data.element.remove();
            ticketRegistry.delete(tid);
            
            if (claimData) {
                delete localClaims[tid];
                claimsChanged = true;
            }
            if (currentSelectedTicket && currentSelectedTicket.transaction_id === tid) {
                clearCheckoutPanel();
            }
        } else {
            // Use hardware-accelerated transform instead of width
            const percentageLeft = Math.max(0, Math.min(1, timeRemainingMs / totalDurationMs));
            data.timerBar.style.transform = `scaleX(${percentageLeft})`;
            
            const pct100 = percentageLeft * 100;
            if (pct100 < 20) data.timerBar.style.backgroundColor = "var(--status-red)";
            else if (pct100 < 50) data.timerBar.style.backgroundColor = "var(--status-amber)";
            else data.timerBar.style.backgroundColor = "var(--status-green)";
        }
    }
    
    // Batch disk writes to prevent thread blocking
    if (claimsChanged) {
        localStorage.setItem("snipe_claims", JSON.stringify(localClaims));
    }
}

btnGenerate.addEventListener("click", async () => {
    const phone = inputPhone.value.trim();
    const email = inputEmail.value.trim();
    if (currentSelectedTicket.platform_name !== 'district' && (!phone || !email)) {
        statusMsg.innerText = "Enter your phone and email first";
        statusMsg.style.color = "var(--status-red)";
        return;
    }
    // 1. Update pre-flight expiration check
    const ticketLifetime = currentSelectedTicket.platform_name === 'district' ? 480 * 1000 : 300 * 1000;
    const normalizedTs = currentSelectedTicket.snipe_timestamp > 100000000000 ? currentSelectedTicket.snipe_timestamp : currentSelectedTicket.snipe_timestamp * 1000;
    if (Date.now() - normalizedTs > ticketLifetime) {
        clearCheckoutPanel();
        return;
    }
    btnGenerate.disabled = true;
    statusMsg.innerText = "Generating QR Code...";
    statusMsg.style.color = "var(--text-muted)";
    qrContainer.style.display = "none";
    try {
        const response = await fetch("/api/proxy", {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "Authorization": `Bearer ${userState.session?.access_token || ""}`
            },
            body: JSON.stringify({
                transaction_id: currentSelectedTicket.transaction_id,
                venue_code: currentSelectedTicket.venue_code,
                trans_uid: currentSelectedTicket.trans_uid,
                email: email,
                phone: phone,
                platform_name: currentSelectedTicket.platform_name,
                content_id: currentSelectedTicket.content_id
            }),
        });
        const data = await response.json();
        const tid = currentSelectedTicket.transaction_id;
        if (data.success) {
            let finalBase64 = '';
            if (currentSelectedTicket.platform_name === 'district') {
                finalBase64 = data.qrImageBase64;
            } else {
                const bmsData = data.BookMyShow;
                if (bmsData?.blnSuccess === "true" && bmsData?.strData?.length > 0) {
                    const upiUrl = bmsData.strData[0].BMSUPIQRPAYURL;
                    const finalImgUrl = `https://in.bookmyshow.com/secure/barcode/?IsImage=Y&strBarcodeType=qrcode&strBarcodeTxt=${upiUrl}&intHeight=300&intWidth=300`;
                    qrContainer.innerHTML = `<div class="qr-wrapper"><img id="qr-result" src="${finalImgUrl}" alt="Payment QR" /></div><p class="qr-instruction">Scan with any UPI app to lock this seat</p>`;
                    localClaims[tid] = { qrUrl: finalImgUrl, claimedAt: Date.now() };
                } else {
                    throw new Error(bmsData?.strMessage || "BookMyShow request failed");
                }
            }
            if (finalBase64) {
                const qrImgDataUri = "data:image/png;base64," + finalBase64;
                qrContainer.innerHTML = `<div class="qr-wrapper"><img id="qr-result" src="${qrImgDataUri}" alt="Payment QR" /></div><p class="qr-instruction">Scan with any UPI app to lock this seat</p>`;
                
                // Set precise expiry timestamp from District API (falling back to 480s if omitted)
                const expiresAtMs = data.expiryTime ? data.expiryTime * 1000 : Date.now() + (480 * 1000);
                localClaims[tid] = { 
                    qrImageBase64: finalBase64, 
                    claimedAt: Date.now(), 
                    expiresAt: expiresAtMs,
                    platform_name: 'district' 
                };
            }
            localStorage.setItem("snipe_claims", JSON.stringify(localClaims));
            collapsibleSection.classList.add("do-animate");
            commandConsole.classList.add("claimed-mode");
            const feedItem = document.querySelector(`.ticket-item[data-tid="${tid}"]`);
            if (feedItem) feedItem.classList.add("claimed-ticket");
            supabase.from("tickets").update({ status: "CLAIMED" }).eq("transaction_id", tid).then();
            qrContainer.style.display = "flex";
            statusMsg.innerText = "Seat claimed. QR image valid for 5 minutes.";
            statusMsg.style.color = "var(--status-green)";
            inputPhone.disabled = true;
            inputEmail.disabled = true;
        } else {
            const prettyError = JSON.stringify(data.details || data.error, null, 2);
            const errorHtml = `<div class="json-response-container"><p class="json-status">Request Failed</p><pre><code>${prettyError}</code></pre></div>`;
            qrContainer.innerHTML = errorHtml;
            qrContainer.style.display = "flex";
            throw new Error(`Proxy error at step ${data.details?.step || 'unknown'}`);
        }
    } catch (error) {
        console.error("Payload Error:", error);
        statusMsg.innerText = error.message;
        statusMsg.style.color = "var(--status-red)";
    } finally {
        btnGenerate.disabled = false;
    }
});

// Run Init
init();
