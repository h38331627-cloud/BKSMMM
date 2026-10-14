# BKSMM

Login (username/email + password) aur Google signup wala BKSMM site.
Page bina login ke khulta hai; top-right mein Login / Sign up option dikhta hai.

## Chalana (apne PC par)
    npm install
    npm start        # http://localhost:3000

## Google signup on karna
1. console.cloud.google.com -> APIs & Services -> Credentials -> Create OAuth client ID (Web application).
2. "Authorized JavaScript origins" mein apna domain daalo (https://tumhara-domain.com) aur testing ke liye http://localhost:3000.
3. Client ID ko env var mein do:  GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
   (Client ID na ho to Google button apne aap chhup jata hai.)

## Forgot password / username (Gmail se reset)
User "Username ya password bhool gaye?" par email daalta hai; use reset link (30 minute valid) aur uska username mail hota hai.
Mail bhejne ke liye Gmail setup:
1. Gmail account mein 2-Step Verification on karo, phir myaccount.google.com/apppasswords se ek App Password banao.
2. Env vars: SMTP_USER=tumhara@gmail.com  SMTP_PASS=<16 letter app password>  APP_URL=https://tumhara-domain.com
   (MAIL_FROM optional.) APP_URL zaroor set karo, warna link localhost ka banega.
SMTP set na ho to reset link sirf server ke console log mein dikhta hai (testing ke liye).

## Host karna (Render / Railway / VPS)
- Build: `npm install`   Start: `npm start`   Node 18+
- Env vars: NODE_ENV=production, APP_URL, SMTP_USER, SMTP_PASS, SESSION_SECRET=<koi lamba random text>, GOOGLE_CLIENT_ID=<upar wala>
- Database SQLite file hai (`data/bksmm.db`). Hosting par persistent disk lagao aur DATA_DIR us disk ke path par set karo,
  warna redeploy par users udd jayenge.
- HTTPS zaroori hai (Render/Railway deta hai).

## Provider API, orders aur admin
- `SMM_API_URL` aur `SMM_API_KEY` env mein do (.env.example dekho). Services provider se aati hain, user ko rate = provider rate + `MARKUP_PERCENT`%.
- User order karta hai to balance turant katta hai. Provider order reject kare to paise wapas. Cancel/Partial order par paise (poore/bache hue hisse ke) wapas.
- Sirf "Default" type services dikhti hain (Custom Comments/Package type abhi support nahi).
- Admin: `ADMIN_USERNAME` + `ADMIN_PASSWORD` set karo, normal login se login karo, phir /admin par username daalkar balance add/kam karo.
  Is username/email se koi signup nahi kar sakta. Har restart par admin password env wala set ho jata hai.
- Apne provider panel mein itna balance rakho ki users ke orders poore ho sakein (Admin page par provider balance dikhta hai).

## Abhi kya kaam nahi karta
- Tickets page bana nahi hai.
- Fund add karna manual hai: user @Mbbsloverr se contact karta hai, tum /admin se balance add karte ho.
- Page ke WhatsApp/Telegram links abhi purane owner ke hain (views/dashboard.html mein badlo).
