/**
 * Linux DO Credit Virtual Goods Platform
 * Based on Cloudflare Worker + D1 Database
 * Supports EasyPay Protocol + Automatic Delivery
 */

import { translations } from './translations.js';

// ==================== Configuration ====================
let CONFIG = null;
let SCHEMA_READY = false;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    category TEXT,
    image TEXT,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    purchase_limit INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    card_key TEXT NOT NULL,
    is_used INTEGER DEFAULT 0,
    reserved_order_id TEXT,
    reserved_at DATETIME,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
    order_id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    amount REAL NOT NULL,
    email TEXT,
    status TEXT DEFAULT 'pending',
    trade_no TEXT,
    card_key TEXT,
    paid_at DATETIME,
    delivered_at DATETIME,
    user_id TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    trust_level INTEGER,
    csrf_token TEXT,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS login_users (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

const DEFAULT_CONFIG = {
    // Linux DO Credit Merchant Config (Secrets loaded from env)
    MERCHANT_ID: '',
    MERCHANT_KEY: '',

    // Admin Config


    // Payment Gateway
    PAY_URL: 'https://credit.linux.do/epay/pay/submit.php',
    REFUND_URL: 'https://credit.linux.do/epay/api.php',

    // Site Config
    SITE_NAME: 'LDC Virtual Goods Shop',
    SITE_DESCRIPTION: 'High-quality virtual goods, instant delivery',
    SITE_FOOTER_LINK: 'https://chatgpt.org.uk',

    // Currency
    CURRENCY: 'credit',  // Linux DO Credit

    // OAUTH
    OAUTH: {
        CLIENT_ID: '',
        CLIENT_SECRET: '',
        REDIRECT_URI: 'https://ldc.chatgpt.org.uk/authcallback',
        AUTH_URL: 'https://connect.linux.do/oauth2/authorize',
        TOKEN_URL: 'https://connect.linux.do/oauth2/token',
        USER_URL: 'https://connect.linux.do/api/user',
    },
    // Admin Usernames (No passwords anymore!)
    ADMIN_USERS: ['chatgpt'], // Default, override with env.ADMIN_USERS

    COOKIE_SESSION: 'ldc_session',
};

const RESERVATION_MINUTES = 1;
const PAYMENT_TIMEOUT_MINUTES = 5;
const RESERVATION_INTERVAL = `-${RESERVATION_MINUTES} minutes`;
const PAYMENT_TIMEOUT_INTERVAL = `-${PAYMENT_TIMEOUT_MINUTES} minutes`;

// ==================== Utilities ====================

function generateOrderId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `ORD${timestamp}${random}`.toUpperCase();
}

async function md5(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('MD5', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateSign(params, merchantKey) {
    const filtered = Object.entries(params)
        .filter(([key, value]) => value !== '' && value !== null && value !== undefined && key !== 'sign' && key !== 'sign_type')
        .sort(([a], [b]) => a.localeCompare(b));
    const str = filtered.map(([key, value]) => `${key}=${value}`).join('&');
    return await md5(str + merchantKey);
}

async function verifySign(params, merchantKey) {
    const receivedSign = params.sign;
    const calculatedSign = await generateSign(params, merchantKey);
    return receivedSign === calculatedSign;
}

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function truncateText(value, max = 30) {
    const text = String(value);
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function formatUserId(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : String(value);
    }
    const str = String(value).trim();
    if (/^\d+\.0+$/.test(str)) return str.replace(/\.0+$/, '');
    return str;
}

async function ensureSchema(db) {
    if (SCHEMA_READY) return;
    const existing = await db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='orders'"
    ).first();
    if (existing?.name) {
        SCHEMA_READY = true;
        return;
    }
    await db.exec(SCHEMA_SQL);
    SCHEMA_READY = true;
}

function renderStarIcon(className) {
    return `<svg viewBox="0 0 24 24" class="${className}" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
}

function renderStarRating(rating, size = 'sm') {
    const sizeClass = size === 'lg' ? 'h-5 w-5' : size === 'md' ? 'h-4 w-4' : 'h-3 w-3';
    const baseClass = 'rating-star';
    const stars = Array.from({ length: 5 }, (_, i) => {
        const active = i < rating;
        const colorClass = active
            ? 'fill-yellow-400 text-yellow-400'
            : 'fill-muted text-muted-foreground/30';
        return `<span class="${baseClass}">${renderStarIcon(`${sizeClass} ${colorClass}`)}</span>`;
    }).join('');
    return `<div class="flex items-center gap-0.5">${stars}</div>`;
}

const SUPPORTED_LOCALES = ['en', 'zh'];
const DEFAULT_LOCALE = 'en';

function getNestedValue(obj, path) {
    return path.split('.').reduce((acc, part) => (acc ? acc[part] : undefined), obj);
}

function interpolate(text, params) {
    if (!params) return text;
    return Object.entries(params).reduce((acc, [key, value]) => {
        return acc.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }, text);
}

function t(locale, key, params) {
    const dict = translations[locale] || translations[DEFAULT_LOCALE];
    const value = getNestedValue(dict, key) || key;
    return interpolate(value, params);
}

function resolveLocale(request) {
    const url = new URL(request.url);
    const queryLocale = url.searchParams.get('lang');
    if (queryLocale && SUPPORTED_LOCALES.includes(queryLocale)) return queryLocale;

    const cookie = request.headers.get('Cookie') || '';
    const match = cookie.match(/ldc_locale=([^;]+)/);
    if (match && SUPPORTED_LOCALES.includes(match[1])) return match[1];

    const acceptLang = (request.headers.get('Accept-Language') || '').toLowerCase();
    if (acceptLang.startsWith('zh')) return 'zh';
    return DEFAULT_LOCALE;
}

function getIntlLocale(locale) {
    return locale === 'zh' ? 'zh-CN' : 'en-US';
}

function buildShopName(locale, customName) {
    if (customName && String(customName).trim()) {
        return String(customName).trim();
    }
    const adminName = (CONFIG?.ADMIN_USERS || []).map(name => name.trim()).filter(Boolean)[0];
    const appName = t(locale, 'common.appName');
    return adminName
        ? t(locale, 'common.shopNamePattern', { name: adminName, appName })
        : appName;
}

// ==================== HTML Templates ====================

// SVG Logo (Blue Diamond)
// We will use Lucide icons mostly, but keep this for brand if needed, or replace with Lucide 'Gem'
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32" fill="none" class="stroke-primary" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`;
const FAVICON_SVG = `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22 fill=%22none%22><rect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%23000000%22/><svg x=%227%22 y=%227%22 width=%2218%22 height=%2218%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23ffffff%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z%22/><path d=%22M3 6h18%22/><path d=%22M16 10a4 4 0 0 1-8 0%22/></svg></svg>`;

function getCommonHead(title, locale = DEFAULT_LOCALE, options = {}) {
    const siteTitle = options.siteTitle || '';
    const description = options.description || CONFIG.SITE_DESCRIPTION || '';
    const fullTitle = siteTitle
        ? (title && title !== siteTitle ? `${title} | ${siteTitle}` : siteTitle)
        : title;
    const safeTitle = fullTitle ? escapeHtml(fullTitle) : '';
    const clientStrings = {
        locale,
        copied: t(locale, 'common.copied'),
        copyFailed: t(locale, 'common.copyFailed'),
        processing: t(locale, 'common.processing'),
        shareCopied: t(locale, 'buy.shareCopied'),
        shareFailed: t(locale, 'buy.shareFailed'),
        refundConfirm: t(locale, 'admin.orders.refundConfirm'),
        refundVerify: t(locale, 'admin.orders.refundVerify'),
        refundInfo: t(locale, 'admin.orders.refundInfo'),
        refundSuccess: t(locale, 'admin.orders.refundSuccess')
    };

    return `
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${safeTitle}</title>
    ${description ? `<meta name="description" content="${escapeHtml(description)}">` : ''}
    <link rel="icon" href="${FAVICON_SVG}">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/lucide@latest"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
    <style>
      :root {
        font-family: 'Inter', sans-serif;
        --radius: 0.75rem;
        --background: 0.99 0 0;
        --foreground: 0.15 0.02 270;
        --card: 1 0 0;
        --card-foreground: 0.15 0.02 270;
        --popover: 1 0 0;
        --popover-foreground: 0.15 0.02 270;
        --primary: 0.45 0.2 270;
        --primary-foreground: 0.99 0 0;
        --secondary: 0.96 0.01 270;
        --secondary-foreground: 0.25 0.02 270;
        --muted: 0.96 0.01 270;
        --muted-foreground: 0.5 0.02 270;
        --accent: 0.94 0.03 200;
        --accent-foreground: 0.25 0.1 200;
        --destructive: 0.6 0.22 25;
        --border: 0.92 0.01 270;
        --input: 0.92 0.01 270;
        --ring: 0.45 0.2 270;
        --glow-primary: 0.55 0.25 270 / 0.3;
        --glow-accent: 0.7 0.2 200 / 0.3;
      }
      .dark {
        --background: 0.12 0.02 270;
        --foreground: 0.95 0.01 270;
        --card: 0.18 0.02 270 / 0.6;
        --card-foreground: 0.95 0.01 270;
        --popover: 0.16 0.02 270 / 0.9;
        --popover-foreground: 0.95 0.01 270;
        --primary: 0.7 0.2 270;
        --primary-foreground: 0.12 0.02 270;
        --secondary: 0.22 0.02 270 / 0.8;
        --secondary-foreground: 0.9 0.01 270;
        --muted: 0.22 0.02 270 / 0.6;
        --muted-foreground: 0.65 0.02 270;
        --accent: 0.65 0.15 200 / 0.3;
        --accent-foreground: 0.85 0.1 200;
        --destructive: 0.65 0.2 25;
        --border: 0.4 0.05 270 / 0.3;
        --input: 0.25 0.02 270 / 0.8;
        --ring: 0.7 0.2 270;
        --glow-primary: 0.6 0.25 270 / 0.4;
        --glow-accent: 0.7 0.2 200 / 0.4;
      }
      * { box-sizing: border-box; }
      body { background: oklch(var(--background)); color: oklch(var(--foreground)); }
      html { scroll-behavior: smooth; }
      summary::-webkit-details-marker { display: none; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: oklch(var(--border)); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: oklch(var(--secondary)); }
      .border-soft { border-color: oklch(0.92 0.01 270 / 0.4); }
      .dark .border-soft { border-color: oklch(0.3 0.04 270 / 0.18); }
      .dark .announcement-card { border-color: oklch(0.4 0.08 270 / 0.18); }
      .divider-soft { background: oklch(0.92 0.01 270 / 0.4); }
      .dark .divider-soft { background: oklch(0.3 0.04 270 / 0.18); }
      .container { margin-left: auto; margin-right: auto; padding-left: 2rem; padding-right: 2rem; max-width: 1280px; }
      .no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
      .no-scrollbar::-webkit-scrollbar { display: none; }
      .line-clamp-2 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .tech-card { background: oklch(1 0 0 / 0.8); backdrop-filter: blur(8px); border: 1px solid oklch(0.9 0.02 270); transition: all 0.5s cubic-bezier(0.2, 0.8, 0.2, 1); }
      .dark .tech-card { background: oklch(0.18 0.02 270 / 0.55); border: 1px solid oklch(0.32 0.04 270 / 0.2); }
      .tech-card:hover { transform: translateY(-2px); box-shadow: 0 20px 40px -15px oklch(0.5 0.2 270 / 0.15), 0 0 0 1px oklch(0.5 0.15 270 / 0.2); }
      .dark .tech-card:hover { border-color: oklch(0.5 0.12 270 / 0.35); box-shadow: 0 20px 40px -15px oklch(0.5 0.2 270 / 0.3), 0 0 30px -10px oklch(var(--glow-primary)); }
      .gradient-text { background: linear-gradient(135deg, oklch(0.7 0.2 270), oklch(0.7 0.18 200)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
      .prose p { margin: 0; }
      .prose ul, .prose ol { padding-left: 1.25rem; }
      .prose li { margin: 0.25rem 0; }
      .rating-star { line-height: 1; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; }
      @keyframes fade-in { from { opacity: 0; transform: translateY(20px) scale(0.95); filter: blur(10px); } to { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); } }
      .animate-fade-in { animation: fade-in 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) forwards; }
    </style>
    <script>
      tailwind.config = {
        darkMode: 'class',
        theme: {
          container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
          extend: {
            colors: {
              border: "oklch(var(--border))", input: "oklch(var(--input))", ring: "oklch(var(--ring))", background: "oklch(var(--background))", foreground: "oklch(var(--foreground))",
              primary: { DEFAULT: "oklch(var(--primary))", foreground: "oklch(var(--primary-foreground))" },
              secondary: { DEFAULT: "oklch(var(--secondary))", foreground: "oklch(var(--secondary-foreground))" },
              destructive: { DEFAULT: "oklch(var(--destructive))", foreground: "oklch(var(--primary-foreground))" },
              muted: { DEFAULT: "oklch(var(--muted))", foreground: "oklch(var(--muted-foreground))" },
              accent: { DEFAULT: "oklch(var(--accent))", foreground: "oklch(var(--accent-foreground))" },
              popover: { DEFAULT: "oklch(var(--popover))", foreground: "oklch(var(--popover-foreground))" },
              card: { DEFAULT: "oklch(var(--card))", foreground: "oklch(var(--card-foreground))" }
            },
            borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
          },
        },
      }
      window.__I18N = ${safeJson(clientStrings)};
      window.addEventListener('load', () => lucide.createIcons());

      (function() {
        const root = document.documentElement;
        const storedTheme = localStorage.getItem('ldc-theme') || 'system';
        const applyTheme = (theme) => {
          if (theme === 'dark') {
            root.classList.add('dark');
          } else if (theme === 'light') {
            root.classList.remove('dark');
          } else {
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            root.classList.toggle('dark', prefersDark);
          }
        };
        applyTheme(storedTheme);
        window.setTheme = (theme) => {
          localStorage.setItem('ldc-theme', theme);
          applyTheme(theme);
        };
        window.setLocale = (lang) => {
          document.cookie = 'ldc_locale=' + lang + '; Path=/; Max-Age=31536000';
          window.location.reload();
        };
        window.showToast = (message, type) => {
          const containerId = 'toast-root';
          let container = document.getElementById(containerId);
          if (!container) {
            container = document.createElement('div');
            container.id = containerId;
            container.className = 'fixed bottom-6 right-6 z-50 flex flex-col gap-2';
            document.body.appendChild(container);
          }
          const toast = document.createElement('div');
          toast.className = 'rounded-lg border bg-background/90 px-4 py-2 text-sm shadow-lg backdrop-blur';
          toast.textContent = message;
          container.appendChild(toast);
          setTimeout(() => {
            toast.remove();
            if (!container.children.length) container.remove();
          }, 3000);
        };

        document.addEventListener('click', async (event) => {
          const target = event.target.closest('[data-copy]');
          if (target) {
            event.preventDefault();
            const value = target.getAttribute('data-copy');
            if (!value) return;
            try {
              await navigator.clipboard.writeText(value);
              window.showToast(window.__I18N?.copied || 'Copied');
            } catch (err) {
              window.showToast(window.__I18N?.copyFailed || 'Copy failed');
            }
          }

          const localeButton = event.target.closest('[data-set-locale]');
          if (localeButton) {
            event.preventDefault();
            window.setLocale(localeButton.getAttribute('data-set-locale'));
            const details = localeButton.closest('details');
            if (details) details.removeAttribute('open');
          }

          const themeButton = event.target.closest('[data-set-theme]');
          if (themeButton) {
            event.preventDefault();
            window.setTheme(themeButton.getAttribute('data-set-theme'));
            const details = themeButton.closest('details');
            if (details) details.removeAttribute('open');
          }

          const openMenus = document.querySelectorAll('details[open]');
          openMenus.forEach((menu) => {
            if (!menu.contains(event.target)) {
              menu.removeAttribute('open');
            }
          });
        });

        const parseDateValue = (raw) => {
          const trimmed = String(raw || '').trim();
          if (!trimmed) return null;
          const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(?:\s*([zZ]|[+-]\d{2}:?\d{2}))?$/);
          if (match) {
            const year = Number(match[1]);
            const month = Number(match[2]) - 1;
            const day = Number(match[3]);
            const hour = Number(match[4] || 0);
            const minute = Number(match[5] || 0);
            const second = Number(match[6] || 0);
            const ms = String(match[7] || '0').padEnd(3, '0');
            let timestamp = Date.UTC(year, month, day, hour, minute, second, Number(ms));
            const tz = match[8];
            if (tz && tz.toUpperCase() !== 'Z') {
              const clean = tz.replace(':', '');
              const sign = clean.startsWith('-') ? -1 : 1;
              const offsetHours = Number(clean.slice(1, 3) || 0);
              const offsetMinutes = Number(clean.slice(3, 5) || 0);
              const offset = (offsetHours * 60 + offsetMinutes) * 60000;
              timestamp -= sign * offset;
            }
            const parsed = new Date(timestamp);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
          }
          let normalized = trimmed.replace(' ', 'T');
          normalized = normalized.replace(/T(\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)\s+([zZ]|[+-]\d{2}:?\d{2})$/, 'T$1$2');
          if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) {
            normalized += 'Z';
          }
          const parsed = new Date(normalized);
          return Number.isNaN(parsed.getTime()) ? null : parsed;
        };

        const formatLocalDate = (date, locale, format) => {
          const options = format === 'dateTime'
            ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }
            : { dateStyle: 'medium', timeZone: 'UTC' };
          const localShifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
          return new Intl.DateTimeFormat(locale, options).format(localShifted);
        };

        const updateDates = () => {
          const locale = document.documentElement.lang === 'zh' ? 'zh-CN' : 'en-US';
          document.querySelectorAll('[data-date]').forEach((node) => {
            const value = node.getAttribute('data-date');
            const format = node.getAttribute('data-format') || 'date';
            const placeholder = node.getAttribute('data-placeholder') || '';
            if (!value) {
              node.textContent = placeholder;
              return;
            }
            const parsed = parseDateValue(value);
            if (!parsed) {
              node.textContent = placeholder;
              return;
            }
            node.textContent = formatLocalDate(parsed, locale, format);
          });
        };
        updateDates();
        window.addEventListener('load', updateDates);
      })();
    </script>
    `;
}

function renderHeader({ user, locale, siteSettings }) {
    const isAdmin = user && user.username && CONFIG.ADMIN_USERS.map(u => u.toLowerCase()).includes(user.username.toLowerCase());
    const shopName = escapeHtml(buildShopName(locale, siteSettings?.shopName));

    const adminLink = isAdmin
        ? `<a href="/admin" class="flex items-center text-sm font-medium text-muted-foreground hover:text-primary">${t(locale, 'common.admin')}</a>`
        : '';

    const userMenu = user ? `
        <details class="relative">
          <summary class="list-none flex items-center gap-2 rounded-full border border-border/50 bg-muted/40 p-1.5 hover:bg-muted/60 cursor-pointer">
            <img src="${user.avatar_url}" alt="${user.name || user.username}" class="h-7 w-7 rounded-full object-cover">
          </summary>
          <div class="absolute right-0 mt-2 w-48 rounded-lg border bg-popover p-2 shadow-lg backdrop-blur">
            <div class="px-2 py-2">
              <p class="text-sm font-medium">${user.name || user.username}</p>
              <p class="text-xs text-muted-foreground">ID: ${escapeHtml(formatUserId(user.user_id))}</p>
            </div>
            <div class="border-t border-border/50 my-2"></div>
            <a href="/orders" class="block rounded-md px-2 py-1.5 text-sm hover:bg-muted">${t(locale, 'common.myOrders')}</a>
            ${isAdmin ? `<a href="/admin" class="block rounded-md px-2 py-1.5 text-sm hover:bg-muted">${t(locale, 'common.dashboard')}</a>` : ''}
            <div class="border-t border-border/50 my-2"></div>
            <form action="/auth/logout" method="POST">
              <button class="w-full text-left rounded-md px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10">${t(locale, 'common.logout')}</button>
            </form>
          </div>
        </details>
    ` : `
        <a href="/auth/login" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-foreground text-background hover:bg-foreground/90 h-9 px-4 py-2">
          ${t(locale, 'common.login')}
        </a>
    `;

    return `<header class="sticky top-0 z-40 w-full border-b border-soft bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div class="container flex h-16 items-center space-x-4 sm:justify-between sm:space-x-0">
            <div class="flex gap-6 md:gap-10">
                <a href="/" class="flex items-center gap-2 group text-muted-foreground hover:text-primary transition-colors">
                    <div class="h-8 w-8 rounded-lg bg-foreground flex items-center justify-center transition-all duration-300">
                        <i data-lucide="shopping-bag" class="h-4 w-4 text-background"></i>
                    </div>
                    <span class="text-sm font-semibold tracking-tight">${shopName}</span>
                </a>
                <nav class="flex items-center gap-6 text-sm">
                    ${adminLink}
                </nav>
            </div>
            <div class="flex flex-1 items-center justify-end space-x-2">
                <details class="relative">
                  <summary class="list-none inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer">
                    <i data-lucide="languages" class="h-4 w-4"></i>
                    <span class="hidden sm:inline">${locale === 'zh' ? '中文' : 'EN'}</span>
                  </summary>
                  <div class="absolute right-0 mt-2 w-32 rounded-lg border bg-popover p-1 shadow-lg backdrop-blur">
                    <button data-set-locale="en" class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted ${locale === 'en' ? 'bg-accent' : ''}">English</button>
                    <button data-set-locale="zh" class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted ${locale === 'zh' ? 'bg-accent' : ''}">\u4e2d\u6587</button>
                  </div>
                </details>
                <details class="relative">
                  <summary class="list-none inline-flex items-center justify-center rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer">
                    <i data-lucide="sun" class="h-4 w-4 block dark:hidden"></i>
                    <i data-lucide="moon" class="h-4 w-4 hidden dark:block"></i>
                  </summary>
                  <div class="absolute right-0 mt-2 w-32 rounded-lg border bg-popover p-1 shadow-lg backdrop-blur">
                    <button data-set-theme="light" class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted">Light</button>
                    <button data-set-theme="dark" class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted">Dark</button>
                    <button data-set-theme="system" class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted">System</button>
                  </div>
                </details>
                ${userMenu}
            </div>
        </div>
    </header>`;
}

function renderFooter(locale) {
    return `<footer class="border-t border-soft py-6 md:py-0 bg-gradient-to-t from-muted/30 to-transparent">
        <div class="container flex flex-col items-center justify-between gap-4 md:h-20 md:flex-row">
            <div class="flex flex-col items-center gap-4 px-8 md:flex-row md:gap-2 md:px-0">
                <p class="text-center text-xs leading-loose text-muted-foreground/80 md:text-left">
                    ${t(locale, 'footer.disclaimer')}
                </p>
            </div>
            <a href="${CONFIG.SITE_FOOTER_LINK}" target="_blank" rel="noreferrer" class="text-center text-xs md:text-left text-muted-foreground/60 hover:text-primary transition-colors duration-300">
                ${t(locale, 'footer.poweredBy')}
            </a>
        </div>
    </footer>`;
}

function renderHomePage(products, { user, locale, announcement, visitorCount, siteSettings }) {
    const categories = Array.from(new Set(products.map(p => p.category).filter(Boolean))).sort();
    const announcementHtml = announcement
        ? `<section class="mb-8">
          <div class="relative overflow-hidden rounded-xl border border-primary/20 announcement-card bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 p-4">
              <div class="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-primary to-primary/50"></div>
              <div class="flex items-start gap-3 pl-3">
                <svg class="w-5 h-5 text-primary shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path>
                </svg>
                <p class="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">${escapeHtml(announcement)}</p>
              </div>
            </div>
          </section>`
        : '';

    const visitorHtml = typeof visitorCount === 'number'
        ? `<div class="mb-6 flex items-center">
             <span class="inline-flex items-center rounded-full border border-border/50 bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
               ${t(locale, 'home.visitorCount', { count: visitorCount })}
             </span>
           </div>`
        : '';

    const cardsHtml = products.map((product, index) => {
        const categoryBadge = product.category && product.category !== 'general'
            ? `<span class="absolute top-3 right-3 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-background/80 backdrop-blur-sm border-border/50 text-foreground shadow-sm capitalize">${escapeHtml(product.category)}</span>`
            : '';
        const ratingBlock = product.review_count > 0
            ? `<div class="flex items-center gap-2 mb-3">
                ${renderStarRating(Math.round(product.rating || 0), 'sm')}
                <span class="text-xs text-muted-foreground font-medium">(${product.review_count})</span>
              </div>`
            : '';

        return `
          <div class="group overflow-hidden flex flex-col tech-card animate-fade-in" style="animation-delay: ${index * 50}ms" data-product-card data-search="${escapeHtml(`${product.name || ''} ${product.description || ''}`.toLowerCase())}" data-category="${escapeHtml((product.category || 'general').toLowerCase())}">
            <div class="aspect-[4/3] bg-gradient-to-br from-muted/30 to-muted/10 relative overflow-hidden">
              <img src="${product.image || `https://api.dicebear.com/7.x/shapes/svg?seed=${product.id}`}" alt="${escapeHtml(product.name)}" class="object-cover w-full h-full transition-transform duration-500 group-hover:scale-105">
              <div class="absolute inset-0 bg-gradient-to-t from-background/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
              ${categoryBadge}
            </div>
            <div class="flex-1 p-5">
              <div class="flex items-start justify-between gap-2 mb-2">
                <h3 class="font-semibold text-lg group-hover:text-primary transition-colors duration-300 leading-tight">${escapeHtml(product.name)}</h3>
              </div>
              ${ratingBlock}
              <div class="text-muted-foreground text-sm line-clamp-2 leading-relaxed prose prose-sm max-w-none [&_p]:inline [&_p]:m-0 [&_h1]:inline [&_h2]:inline [&_h3]:inline [&_h4]:inline [&_h5]:inline [&_h6]:inline [&_ul]:inline [&_ol]:inline [&_li]:inline" data-markdown-target></div>
              <script type="application/json" data-markdown-source data-markdown-limit="160">${safeJson(product.description || t(locale, 'buy.noDescription'))}</script>
            </div>
            <div class="p-5 pt-0 flex items-end justify-between gap-3">
              <div class="shrink-0 flex flex-col">
                <span class="text-xs text-muted-foreground font-medium uppercase tracking-wider">${t(locale, 'common.credits')}</span>
                <span class="text-2xl font-bold font-mono tracking-tight">${Number(product.price)}</span>
              </div>
              <div class="flex flex-col items-end gap-2 min-w-0">
                <div class="flex flex-wrap justify-end gap-1.5 opacity-80 hover:opacity-100 transition-opacity">
                  <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold text-muted-foreground border-border/50 whitespace-nowrap">
                    ${t(locale, 'common.sold')} ${product.sold || 0}
                  </span>
                  <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${product.stock > 0 ? 'bg-secondary text-secondary-foreground' : 'bg-destructive text-destructive-foreground'}">
                    ${product.stock > 0 ? `${t(locale, 'common.stock')} ${product.stock}` : t(locale, 'common.outOfStock')}
                  </span>
                </div>
                <a href="/buy/${product.id}" class="self-end">
                  <span class="inline-flex items-center justify-center h-8 px-3 text-xs font-medium rounded-md bg-foreground text-background hover:bg-foreground/90 shadow-md hover:shadow-lg transition-all">
                    ${t(locale, 'common.viewDetails')}
                  </span>
                </a>
              </div>
            </div>
          </div>`;
    }).join('');

    const emptyState = `
      <div class="text-center py-20 bg-muted/30 rounded-2xl border border-dashed border-muted-foreground/20" data-empty-state>
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-muted/50 mb-4">
          <i data-lucide="package" class="w-8 h-8 text-muted-foreground/50"></i>
        </div>
        <p class="text-muted-foreground font-medium">${t(locale, 'home.noProducts')}</p>
        <p class="text-sm text-muted-foreground/60 mt-2">${t(locale, 'home.checkBackLater')}</p>
        ${categories.length ? `<button data-category-button="all" class="mt-4 text-primary hover:underline">${t(locale, 'common.all')}</button>` : ''}
      </div>
    `;

    const meta = { siteTitle: siteSettings?.siteTitle || CONFIG.SITE_NAME, description: siteSettings?.siteDescription || CONFIG.SITE_DESCRIPTION };
    return `<!DOCTYPE html><html lang="${locale}" class="h-full"><head>${getCommonHead(meta.siteTitle, locale, meta)}</head>
    <body class="min-h-screen bg-background font-sans antialiased">
      <div class="relative flex min-h-screen flex-col">
        ${renderHeader({ user, locale, siteSettings })}
        <main class="container py-8 md:py-16">
          ${announcementHtml}
          ${visitorHtml}
          <div class="grid grid-cols-1 lg:grid-cols-4 gap-8">
            <aside class="lg:col-span-1">
              <div class="sticky top-24 space-y-6">
                <div class="relative">
                  <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"></i>
                  <input data-search-input type="search" placeholder="${t(locale, 'common.searchPlaceholder')}" class="pl-9 bg-muted/50 border-muted-foreground/20 focus:bg-background transition-colors flex h-10 w-full rounded-md border border-input px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                </div>
                <div class="space-y-4">
                  <h2 class="text-lg font-semibold tracking-tight px-1 flex items-center gap-2">
                    <i data-lucide="filter" class="h-4 w-4 text-primary"></i>
                    ${t(locale, 'common.categories')}
                  </h2>
                  <div class="flex flex-row lg:flex-col gap-2 overflow-x-auto pb-4 lg:pb-0 no-scrollbar">
                    <button data-category-button="all" class="justify-start whitespace-nowrap inline-flex items-center rounded-md px-3 py-2 text-sm font-medium bg-primary text-primary-foreground shadow-lg shadow-primary/20">${t(locale, 'common.all')}</button>
                    ${categories.map(category => `
                      <button data-category-button="${escapeHtml(category.toLowerCase())}" class="justify-start capitalize whitespace-nowrap inline-flex items-center rounded-md px-3 py-2 text-sm font-medium hover:bg-muted">
                        ${escapeHtml(category)}
                      </button>`).join('')}
                  </div>
                </div>
              </div>
            </aside>
            <section class="lg:col-span-3">
              ${products.length
        ? `<div class="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3" data-products-grid>${cardsHtml}</div>
              <div class="hidden" data-filter-empty>${emptyState}</div>`
        : emptyState}
            </section>
          </div>
        </main>
        ${renderFooter(locale)}
      </div>
      <script>
        const sanitizeInlineHtml = (html) => {
          const container = document.createElement('div');
          container.innerHTML = html;
          const allowedTags = new Set(['strong', 'em', 'del', 'span', 'p', 'br']);
          const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
          const nodes = [];
          while (walker.nextNode()) nodes.push(walker.currentNode);
          nodes.forEach((node) => {
            const tag = node.tagName.toLowerCase();
            if (!allowedTags.has(tag)) {
              const parent = node.parentNode;
              if (!parent) return;
              while (node.firstChild) parent.insertBefore(node.firstChild, node);
              parent.removeChild(node);
              return;
            }
            while (node.attributes && node.attributes.length) {
              node.removeAttribute(node.attributes[0].name);
            }
          });
          return container.innerHTML;
        };

        document.querySelectorAll('[data-markdown-source]').forEach((node) => {
          const target = node.previousElementSibling;
          if (!target || !target.hasAttribute('data-markdown-target')) return;
          const limit = Number(node.getAttribute('data-markdown-limit') || '160');
          try {
            let markdown = JSON.parse(node.textContent || '""');
            markdown = typeof markdown === 'string' ? markdown : String(markdown || '');
            markdown = markdown.trim();
            markdown = markdown.replace(/</g, '&lt;');
            let preview = markdown;
            if (limit > 0 && markdown.length > limit) {
              preview = markdown.slice(0, limit).trimEnd() + '...';
            }
            if (typeof marked !== 'undefined') {
              target.innerHTML = sanitizeInlineHtml(marked.parse(preview || ''));
            } else {
              target.textContent = preview || '';
            }
          } catch (err) {
            target.textContent = node.textContent || '';
          }
        });

        const searchInput = document.querySelector('[data-search-input]');
        const categoryButtons = Array.from(document.querySelectorAll('[data-category-button]'));
        const cards = Array.from(document.querySelectorAll('[data-product-card]'));
        const emptyState = document.querySelector('[data-filter-empty]');

        let selectedCategory = 'all';

        function updateCategoryButtons() {
          categoryButtons.forEach(btn => {
            const isActive = btn.getAttribute('data-category-button') === selectedCategory;
            btn.classList.toggle('bg-primary', isActive);
            btn.classList.toggle('text-primary-foreground', isActive);
            btn.classList.toggle('shadow-lg', isActive);
            btn.classList.toggle('shadow-primary/20', isActive);
          });
        }

        function applyFilters() {
          const term = (searchInput && searchInput.value || '').trim().toLowerCase();
          let visibleCount = 0;
          cards.forEach(card => {
            const searchText = card.getAttribute('data-search') || '';
            const category = card.getAttribute('data-category') || 'general';
            const matchesTerm = !term || searchText.includes(term);
            const matchesCategory = selectedCategory === 'all' || category === selectedCategory;
            const isVisible = matchesTerm && matchesCategory;
            card.classList.toggle('hidden', !isVisible);
            if (isVisible) visibleCount += 1;
          });
          if (emptyState) {
            emptyState.classList.toggle('hidden', visibleCount > 0);
          }
        }

        if (searchInput) {
          searchInput.addEventListener('input', applyFilters);
        }

        categoryButtons.forEach(btn => {
          btn.addEventListener('click', () => {
            selectedCategory = btn.getAttribute('data-category-button') || 'all';
            updateCategoryButtons();
            applyFilters();
          });
        });

        updateCategoryButtons();
        applyFilters();
      </script>
    </body></html>`;
}

function renderBuyPage(product, user = null, options = {}) {
    const {
        locale,
        errorMessage = null,
        reviews = [],
        averageRating = 0,
        reviewCount = 0,
        canReview = false,
        reviewOrderId = null,
        siteSettings
    } = options;

    const isLocked = product.stock < 1 && product.reserved > 0;
    const errorHtml = errorMessage
        ? `<div class="rounded-xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive text-center">${escapeHtml(errorMessage)}</div>`
        : '';

    const ratingSummary = reviewCount > 0
        ? `${Number(averageRating || 0).toFixed(1)}`
        : null;

    const reviewListHtml = reviewCount > 0
        ? `<div class="space-y-4">
            <div class="flex items-center gap-3 p-4 bg-muted/30 rounded-lg">
              <div class="text-3xl font-bold gradient-text">${Number(averageRating).toFixed(1)}</div>
              <div class="space-y-1">
                ${renderStarRating(Math.round(averageRating), 'md')}
                <p class="text-sm text-muted-foreground">${reviewCount} ${t(locale, 'review.title').toLowerCase()}</p>
              </div>
            </div>
            <div class="space-y-3">
              ${reviews.map(review => {
                const displayName = review.username || t(locale, 'common.guest');
                const avatarSeed = encodeURIComponent(review.user_id || review.username || 'user');
                let avatarUrl = review.avatar_url ? String(review.avatar_url).trim() : '';
                if (avatarUrl && avatarUrl.startsWith('/')) {
                  avatarUrl = `https://linux.do${avatarUrl}`;
                }
                if (!avatarUrl) {
                  avatarUrl = `https://api.dicebear.com/7.x/initials/svg?seed=${avatarSeed}`;
                }
                return `
                <div class="rounded-lg border border-soft bg-card/50 p-4">
                  <div class="flex items-start justify-between gap-4">
                    <div class="flex items-start gap-3">
                      <img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(displayName)}" class="h-9 w-9 rounded-full border border-border/50 bg-muted/40 object-cover">
                      <div class="space-y-1">
                        <div class="flex items-center gap-2">
                          <span class="font-medium text-sm">${escapeHtml(displayName)}</span>
                          ${renderStarRating(review.rating, 'sm')}
                        </div>
                        ${review.comment ? `<p class="text-sm text-muted-foreground">${escapeHtml(review.comment)}</p>` : ''}
                      </div>
                    </div>
                    <time data-date="${review.created_at}" data-format="date" class="text-xs text-muted-foreground shrink-0"></time>
                  </div>
                </div>`;
              }).join('')}
            </div>
          </div>`
        : `<div class="text-center py-8 text-muted-foreground">
            <p>${t(locale, 'review.noReviews')}</p>
          </div>`;

    const reviewFormHtml = canReview && reviewOrderId
        ? `<div class="p-4 border rounded-lg bg-muted/20">
            <h3 class="text-sm font-medium mb-3">${t(locale, 'review.leaveReview')}</h3>
            <form action="/review/create" method="POST" class="space-y-4" data-review-form>
              <input type="hidden" name="product_id" value="${product.id}">
              <input type="hidden" name="order_id" value="${reviewOrderId}">
              <input type="hidden" name="csrf_token" value="${user?.csrf_token || ''}">
              <input type="hidden" name="rating" value="5" data-rating-input>
              <div class="space-y-2">
                <label class="text-sm font-medium">${t(locale, 'review.yourRating')}</label>
                <div class="flex items-center gap-1" data-rating-stars>
                  ${Array.from({ length: 5 }, (_, i) => `<button type="button" data-rating-value="${i + 1}" class="rating-star">${renderStarIcon('h-5 w-5 fill-muted text-muted-foreground/30')}</button>`).join('')}
                </div>
              </div>
              <div class="space-y-2">
                <label class="text-sm font-medium">${t(locale, 'review.yourComment')}</label>
                <textarea name="comment" rows="3" placeholder="${t(locale, 'review.commentPlaceholder')}" class="resize-none flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"></textarea>
              </div>
              <button class="w-full inline-flex items-center justify-center rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 h-10 px-4 py-2">
                ${t(locale, 'review.submit')}
              </button>
            </form>
          </div>`
        : '';

    const productDescription = product.description || t(locale, 'buy.noDescription');

    const meta = { siteTitle: siteSettings?.siteTitle || CONFIG.SITE_NAME, description: siteSettings?.siteDescription || CONFIG.SITE_DESCRIPTION };
    return `<!DOCTYPE html><html lang="${locale}" class="h-full"><head>${getCommonHead(`${t(locale, 'buy.title')} - ${product.name}`, locale, meta)}</head>
    <body class="min-h-screen bg-background font-sans antialiased">
      <div class="relative flex min-h-screen flex-col">
        ${renderHeader({ user, locale, siteSettings })}
        <main class="container py-8 md:py-16">
          <div class="mx-auto max-w-3xl">
            <div class="tech-card rounded-xl relative z-10">
              <div class="relative p-6 pb-0">
                <div class="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full blur-3xl -z-10"></div>
                <div class="flex items-start justify-between gap-4">
                  <div class="space-y-2">
                    <h1 class="text-2xl md:text-3xl font-bold">${escapeHtml(product.name)}</h1>
                    ${product.category && product.category !== 'general' ? `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold text-muted-foreground mt-1 capitalize">${escapeHtml(product.category)}</span>` : ''}
                  </div>
                  <div class="text-right shrink-0">
                    <div class="text-4xl font-bold gradient-text">${Number(product.price)}</div>
                    <span class="text-sm text-muted-foreground">${t(locale, 'common.credits')}</span>
                    <div class="mt-2 flex flex-col items-end gap-2">
                      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${product.stock > 0 ? 'border-primary/30 text-primary' : 'border-destructive/30 text-destructive'}">
                        ${product.stock > 0 ? `${t(locale, 'common.stock')}: ${product.stock}` : t(locale, 'common.outOfStock')}
                      </span>
                      ${product.purchase_limit && product.purchase_limit > 0 ? `<span class="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold text-muted-foreground">${t(locale, 'buy.purchaseLimit', { limit: product.purchase_limit })}</span>` : ''}
                    </div>
                  </div>
                </div>
              </div>

              <div class="my-6 h-px divider-soft"></div>

              <div class="space-y-6 px-6 pb-6">
                ${errorHtml}
                <div class="aspect-video relative bg-gradient-to-br from-muted/20 to-muted/5 rounded-xl overflow-hidden flex items-center justify-center border border-soft">
                  <img src="${product.image || `https://api.dicebear.com/7.x/shapes/svg?seed=${product.id}`}" alt="${escapeHtml(product.name)}" class="max-w-full max-h-full object-contain">
                  <div class="absolute top-0 left-0 w-8 h-8 border-t-2 border-l-2 border-primary/30 rounded-tl-xl"></div>
                  <div class="absolute bottom-0 right-0 w-8 h-8 border-b-2 border-r-2 border-primary/30 rounded-br-xl"></div>
                </div>

                <div class="space-y-4">
                  <h3 class="text-sm font-medium text-muted-foreground uppercase tracking-wider">${t(locale, 'buy.description')}</h3>
                  <div class="prose prose-sm max-w-none text-foreground/80 leading-relaxed break-words" id="product-description"></div>
                  <script id="product-description-data" type="application/json">${safeJson(productDescription)}</script>
                </div>
              </div>

              <div class="border-t border-soft px-6 py-6 space-y-4">
                <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                  <div class="flex-1">
                    ${user ? (product.stock > 0
                        ? `<form action="/order/create" method="POST" class="space-y-3" data-buy-form>
                             <input type="hidden" name="product_id" value="${product.id}">
                             <input type="hidden" name="csrf_token" value="${user.csrf_token || ''}">
                             <button type="submit" class="w-full md:w-auto inline-flex items-center justify-center rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 h-10 px-6">
                               ${t(locale, 'common.buyNow')}
                             </button>
                           </form>`
                        : `<div class="flex items-center gap-2 text-destructive">
                             <i data-lucide="alert-triangle" class="w-5 h-5"></i>
                             <p class="font-medium">${t(locale, 'buy.outOfStockMessage')}</p>
                           </div>` )
                        : `<div class="flex items-center gap-2 text-muted-foreground bg-muted/30 px-4 py-3 rounded-lg w-full sm:w-auto">
                             <i data-lucide="user" class="w-5 h-5"></i>
                             <p>${t(locale, 'buy.loginToBuy')}</p>
                           </div>`
                    }
                  </div>
                  <details class="relative">
                    <summary class="list-none inline-flex items-center justify-center rounded-md text-sm font-medium border border-input bg-background hover:bg-accent h-10 px-4 cursor-pointer">
                      <i data-lucide="share-2" class="mr-2 h-4 w-4"></i>
                      ${t(locale, 'buy.share')}
                    </summary>
                    <div class="absolute right-0 mt-2 w-64 rounded-lg border bg-popover p-3 shadow-lg backdrop-blur z-50">
                      <div class="text-sm font-medium mb-2">${t(locale, 'buy.shareTitle')}</div>
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <a id="share-x" class="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm hover:bg-accent" target="_blank" rel="noopener noreferrer">X (Twitter)</a>
                        <a id="share-facebook" class="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm hover:bg-accent" target="_blank" rel="noopener noreferrer">Facebook</a>
                        <a id="share-telegram" class="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm hover:bg-accent" target="_blank" rel="noopener noreferrer">Telegram</a>
                        <a id="share-whatsapp" class="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm hover:bg-accent" target="_blank" rel="noopener noreferrer">WhatsApp</a>
                        <a id="share-line" class="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm hover:bg-accent" target="_blank" rel="noopener noreferrer">Line</a>
                        <button type="button" id="share-copy" class="inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm hover:bg-accent">${t(locale, 'buy.shareCopy')}</button>
                      </div>
                    </div>
                  </details>
                </div>
                <p class="text-xs text-muted-foreground">${t(locale, 'buy.paymentTimeoutNotice')}</p>
              </div>
            </div>

            <div class="tech-card mt-8 rounded-xl">
              <div class="p-6 border-b border-soft">
                <div class="flex items-center justify-between">
                  <h2 class="flex items-center gap-3 text-lg font-semibold">
                    ${t(locale, 'review.title')}
                    ${ratingSummary ? `<span class="flex items-center gap-2 text-sm font-normal text-muted-foreground">${renderStarRating(Math.round(averageRating), 'sm')} (${ratingSummary})</span>` : ''}
                  </h2>
                </div>
              </div>
              <div class="p-6 space-y-6">
                ${reviewFormHtml}
                ${reviewListHtml}
              </div>
            </div>
          </div>
        </main>
        ${renderFooter(locale)}
      </div>
      <script>
        const descData = document.getElementById('product-description-data');
        const descEl = document.getElementById('product-description');
        if (descData && descEl) {
          try {
            const markdown = JSON.parse(descData.textContent || '""');
            if (typeof marked !== 'undefined') {
              descEl.innerHTML = marked.parse(markdown || '');
            } else {
              descEl.textContent = markdown || '';
            }
          } catch (err) {
            descEl.textContent = descData.textContent || '';
          }
        }

        const shareUrl = window.location.href;
        const shareText = ${safeJson(product.name)};
        const encodedUrl = encodeURIComponent(shareUrl);
        const encodedText = encodeURIComponent(shareText);
        const shareLinks = {
          x: 'https://twitter.com/intent/tweet?text=' + encodedText + '&url=' + encodedUrl,
          facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + encodedUrl,
          telegram: 'https://t.me/share/url?url=' + encodedUrl + '&text=' + encodedText,
          whatsapp: 'https://wa.me/?text=' + encodeURIComponent(shareText + ' ' + shareUrl),
          line: 'https://social-plugins.line.me/lineit/share?url=' + encodedUrl
        };
        const shareX = document.getElementById('share-x');
        const shareFacebook = document.getElementById('share-facebook');
        const shareTelegram = document.getElementById('share-telegram');
        const shareWhatsapp = document.getElementById('share-whatsapp');
        const shareLine = document.getElementById('share-line');
        if (shareX) shareX.href = shareLinks.x;
        if (shareFacebook) shareFacebook.href = shareLinks.facebook;
        if (shareTelegram) shareTelegram.href = shareLinks.telegram;
        if (shareWhatsapp) shareWhatsapp.href = shareLinks.whatsapp;
        if (shareLine) shareLine.href = shareLinks.line;
        const shareCopy = document.getElementById('share-copy');
        if (shareCopy) {
          shareCopy.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(shareUrl);
              window.showToast(window.__I18N?.shareCopied || 'Link copied');
            } catch (err) {
              window.showToast(window.__I18N?.shareFailed || 'Copy failed');
            }
          });
        }

        const reviewForm = document.querySelector('[data-review-form]');
        if (reviewForm) {
          const ratingInput = reviewForm.querySelector('[data-rating-input]');
          const starButtons = reviewForm.querySelectorAll('[data-rating-value]');
          const setRating = (value) => {
            if (ratingInput) ratingInput.value = value;
            starButtons.forEach(btn => {
              const active = Number(btn.getAttribute('data-rating-value')) <= Number(value);
              const icon = btn.querySelector('svg');
              if (!icon) return;
              icon.classList.toggle('fill-yellow-400', active);
              icon.classList.toggle('text-yellow-400', active);
              icon.classList.toggle('fill-muted', !active);
              icon.classList.toggle('text-muted-foreground/30', !active);
            });
          };
          starButtons.forEach(btn => {
            btn.addEventListener('click', () => setRating(btn.getAttribute('data-rating-value')));
          });
          setRating(5);
        }
      </script>
    </body></html>`;
}

function renderOrderPage(order, { showKey, user, locale, siteSettings }) {
    const orderStatus = order.status || 'pending';
    const statusText = t(locale, `order.status.${orderStatus}`) || orderStatus.toUpperCase();
    const badgeClass = orderStatus === 'delivered'
        ? 'bg-green-500/10 text-green-500 border-green-500/30'
        : orderStatus === 'paid'
            ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30'
            : orderStatus === 'cancelled'
                ? 'bg-red-500/10 text-red-600 border-red-500/30'
                : orderStatus === 'refunded'
                    ? 'bg-purple-500/10 text-purple-600 border-purple-500/30'
                    : 'border-border/50 text-muted-foreground';

    const statusMessage = orderStatus === 'paid'
        ? t(locale, 'order.stockDepleted')
        : orderStatus === 'cancelled'
            ? t(locale, 'order.cancelledMessage')
            : orderStatus === 'refunded'
                ? t(locale, 'order.orderRefunded')
                : t(locale, 'order.waitingPayment');

    const keyBlock = orderStatus === 'delivered'
        ? (showKey
            ? `<div class="space-y-3">
                <h3 class="font-semibold flex items-center gap-2">
                  <i data-lucide="check-circle-2" class="h-4 w-4 text-green-500"></i>
                  ${t(locale, 'order.yourContent')}
                </h3>
                <div class="relative rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-sm text-slate-100 break-all whitespace-pre-wrap">
                  <div class="absolute top-2 left-3 flex gap-1.5">
                    <div class="w-2.5 h-2.5 rounded-full bg-red-500/80"></div>
                    <div class="w-2.5 h-2.5 rounded-full bg-yellow-500/80"></div>
                    <div class="w-2.5 h-2.5 rounded-full bg-green-500/80"></div>
                  </div>
                  <button data-copy="${escapeHtml(order.card_key)}" aria-label="${t(locale, 'common.copy')}" title="${t(locale, 'common.copy')}" class="absolute top-2 right-2 inline-flex h-5 w-5 items-center justify-center rounded border border-slate-700/80 bg-slate-900 text-slate-200 hover:bg-slate-800">
                    <i data-lucide="copy" class="h-2.5 w-2.5"></i>
                  </button>
                  <div class="pt-6">${escapeHtml(order.card_key)}</div>
                </div>
                <p class="text-xs text-muted-foreground flex items-center gap-1.5">
                  <i data-lucide="info" class="w-3.5 h-3.5"></i>
                  ${t(locale, 'order.saveKeySecurely')}
                </p>
              </div>`
            : `<div class="p-4 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 rounded-xl flex gap-3 text-sm border border-yellow-500/20">
                <i data-lucide="alert-circle" class="h-5 w-5 shrink-0"></i>
                <p>${t(locale, 'order.loginToView')}</p>
              </div>`)
        : `<div class="flex items-center gap-3 p-4 rounded-xl border ${orderStatus === 'paid' ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20' : 'bg-muted/20 text-muted-foreground border-border/30'}">
             <i data-lucide="${orderStatus === 'paid' ? 'alert-circle' : 'clock'}" class="h-5 w-5"></i>
             <p class="text-sm">${statusMessage}</p>
           </div>`;

    const meta = { siteTitle: siteSettings?.siteTitle || CONFIG.SITE_NAME, description: siteSettings?.siteDescription || CONFIG.SITE_DESCRIPTION };
    return `<!DOCTYPE html><html lang="${locale}" class="h-full"><head>${getCommonHead(t(locale, 'order.title'), locale, meta)}</head>
    <body class="min-h-screen bg-background font-sans antialiased">
       <div class="relative flex min-h-screen flex-col">
         ${renderHeader({ user, locale, siteSettings })}
         <main class="container py-12 max-w-2xl">
            <div class="tech-card overflow-hidden rounded-xl">
              <div class="relative p-6">
                ${orderStatus === 'delivered' ? '<div class="absolute top-0 right-0 w-32 h-32 bg-green-500/10 rounded-full blur-3xl"></div>' : ''}
                <div class="flex items-center justify-between gap-4">
                  <div class="space-y-1">
                    <h1 class="text-xl font-semibold">${t(locale, 'order.title')}</h1>
                    <p class="font-mono text-xs bg-muted/50 px-2 py-1 rounded inline-block">${order.order_id}</p>
                  </div>
                  <span class="uppercase text-xs tracking-wider px-2.5 py-1 rounded-full border ${badgeClass}">
                    ${statusText}
                  </span>
                </div>
              </div>

              <div class="space-y-6 px-6 pb-6">
                <div class="grid gap-4">
                  <div class="flex justify-between items-center p-4 bg-gradient-to-r from-muted/40 to-muted/20 rounded-xl border border-border/30">
                    <div class="space-y-1">
                      <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">${t(locale, 'order.product')}</p>
                      <p class="font-semibold">${escapeHtml(order.product_name)}</p>
                    </div>
                    <div class="h-12 w-12 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20">
                      <i data-lucide="package" class="h-5 w-5 text-primary"></i>
                    </div>
                  </div>
                  <div class="flex justify-between items-center p-4 bg-gradient-to-r from-muted/40 to-muted/20 rounded-xl border border-border/30">
                    <div class="space-y-1">
                      <p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">${t(locale, 'order.amountPaid')}</p>
                      <p class="font-semibold text-xl">
                        <span class="gradient-text">${Number(order.amount)}</span>
                        <span class="text-xs font-normal text-muted-foreground ml-1.5">${t(locale, 'common.credits')}</span>
                      </p>
                    </div>
                    <div class="h-12 w-12 bg-gradient-to-br from-primary/20 to-primary/5 rounded-xl flex items-center justify-center border border-primary/20">
                      <i data-lucide="credit-card" class="h-5 w-5 text-primary"></i>
                    </div>
                  </div>
                  <div class="grid grid-cols-2 gap-3">
                    <div class="p-4 bg-muted/20 rounded-xl border border-border/20">
                      <p class="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">${t(locale, 'order.createdAt')}</p>
                      <time data-date="${order.created_at}" data-format="dateTime" data-placeholder="-" class="text-sm font-medium"></time>
                    </div>
                    <div class="p-4 bg-muted/20 rounded-xl border border-border/20">
                      <p class="text-xs text-muted-foreground mb-1.5 uppercase tracking-wider">${t(locale, 'order.paidAt')}</p>
                      <time data-date="${order.paid_at || ''}" data-format="dateTime" data-placeholder="-" class="text-sm font-medium"></time>
                    </div>
                  </div>
                </div>

                <div class="h-px bg-border/50"></div>

                ${keyBlock}
              </div>
            </div>
         </main>
         ${renderFooter(locale)}
       </div>
    </body></html>`;
}

// --- Admin Views (Tailwind) ---

function renderAdminLogin() {
    return `<!DOCTYPE html><html class="h-full"><head>${getCommonHead('Admin Login')}</head>
    <body class="flex min-h-full items-center justify-center bg-background">
      <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm w-full max-w-sm">
        <div class="flex flex-col space-y-1.5 p-6">
            <h3 class="font-semibold tracking-tight text-2xl text-center">Admin Login</h3>
            <p class="text-sm text-muted-foreground text-center">Enter your access credentials</p>
        </div>
        <div class="p-6 pt-0">
             <form action="/admin/login" method="POST" class="space-y-4">
                 <input type="password" name="password" placeholder="Password" required class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                 <button class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-foreground text-background hover:bg-foreground/90 h-10 px-4 py-2 w-full">
                    Login
                 </button>
             </form>
        </div>
      </div>
    </body></html>`;
}

function renderAdminLayout(content, activeTab, user, locale, siteSettings) {
    const meta = { siteTitle: siteSettings?.siteTitle || CONFIG.SITE_NAME, description: siteSettings?.siteDescription || CONFIG.SITE_DESCRIPTION };
    return `<!DOCTYPE html><html lang="${locale}" class="h-full"><head>${getCommonHead(t(locale, 'common.adminTitle'), locale, meta)}</head>
    <body class="min-h-screen bg-background font-sans antialiased">
      <div class="flex min-h-screen flex-col md:flex-row">
        <aside class="w-full md:w-64 bg-muted/40 border-r border-soft md:min-h-screen p-6 space-y-4">
          <div class="px-2 mb-4">
            <a href="/" class="flex items-center gap-2 group text-muted-foreground hover:text-primary transition-colors">
              <span class="h-8 w-8 rounded-lg bg-foreground flex items-center justify-center transition-all duration-300">
                <i data-lucide="shopping-bag" class="h-4 w-4 text-background"></i>
              </span>
              <span class="text-sm font-semibold tracking-tight">${escapeHtml(buildShopName(locale, siteSettings?.shopName))}</span>
            </a>
          </div>
          <p class="px-2 text-xs uppercase tracking-wider text-muted-foreground mb-2">${t(locale, 'common.adminTitle')}</p>
          <nav class="flex flex-col gap-2">
            <a href="/admin" class="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium ${activeTab === 'products' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}">
              <i data-lucide="package" class="mr-2 h-4 w-4"></i>${t(locale, 'common.dashboardProducts')}
            </a>
            <a href="/admin/orders" class="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium ${activeTab === 'orders' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}">
              <i data-lucide="credit-card" class="mr-2 h-4 w-4"></i>${t(locale, 'common.ordersRefunds')}
            </a>
            <a href="/admin/announcement" class="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium ${activeTab === 'announcement' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}">
              <i data-lucide="megaphone" class="mr-2 h-4 w-4"></i>${t(locale, 'announcement.title')}
            </a>
            <a href="/admin/settings" class="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium ${activeTab === 'settings' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}">
              <i data-lucide="settings" class="mr-2 h-4 w-4"></i>${t(locale, 'common.settings')}
            </a>
          </nav>
          <div class="mt-auto pt-6 border-t border-soft">
            <div class="px-2 text-sm text-muted-foreground mb-4">
              ${t(locale, 'common.loggedInAs')}<br>
              <strong class="text-foreground">${escapeHtml(user.username)}</strong>
            </div>
            <form action="/auth/logout" method="POST">
              <button class="w-full inline-flex items-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted">
                <i data-lucide="log-out" class="mr-2 h-4 w-4"></i>${t(locale, 'common.logout')}
              </button>
            </form>
          </div>
        </aside>
        <main class="flex-1 p-6 md:p-12 overflow-y-auto">
          ${content}
        </main>
      </div>
    </body></html>`;
}

function renderAdminDashboardWithUser(products, user, locale, stats, siteSettings) {
    const dashboardStats = stats || {
        today: { count: 0, revenue: 0 },
        week: { count: 0, revenue: 0 },
        month: { count: 0, revenue: 0 },
        total: { count: 0, revenue: 0 }
    };

    const statCards = [
        { key: 'today', icon: 'shopping-cart', data: dashboardStats.today },
        { key: 'week', icon: 'trending-up', data: dashboardStats.week },
        { key: 'month', icon: 'credit-card', data: dashboardStats.month },
        { key: 'total', icon: 'package', data: dashboardStats.total }
    ];

    const statsHtml = statCards.map(card => `
        <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm p-6">
          <div class="flex items-center justify-between pb-2">
            <p class="text-sm font-medium text-muted-foreground">${t(locale, `admin.stats.${card.key}`)}</p>
            <i data-lucide="${card.icon}" class="h-4 w-4 text-muted-foreground"></i>
          </div>
          <div class="text-2xl font-bold">${card.data.count}</div>
          <p class="text-xs text-muted-foreground">${Number(card.data.revenue).toFixed(0)} ${t(locale, 'common.credits')}</p>
        </div>
    `).join('');

    const tableRows = products.map((p, idx) => {
        const isActive = Number(p.is_active) !== 0;
        const rowOpacity = isActive ? '' : 'opacity-50';
        const displayStock = Number(p.stock || 0) + Number(p.reserved || 0);
        const categoryLabel = p.category || 'general';

        return `
        <tr class="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted ${rowOpacity}">
             <td class="p-4 align-middle">
               <div class="flex flex-col gap-1">
                 <form action="/admin/product/reorder" method="POST">
                   <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                   <input type="hidden" name="product_id" value="${p.id}">
                   <input type="hidden" name="direction" value="up">
                   <button type="submit" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40" ${idx === 0 ? 'disabled' : ''}>
                     <i data-lucide="arrow-up" class="h-3 w-3"></i>
                   </button>
                 </form>
                 <form action="/admin/product/reorder" method="POST">
                   <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                   <input type="hidden" name="product_id" value="${p.id}">
                   <input type="hidden" name="direction" value="down">
                   <button type="submit" class="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-40" ${idx === products.length - 1 ? 'disabled' : ''}>
                     <i data-lucide="arrow-down" class="h-3 w-3"></i>
                   </button>
                 </form>
               </div>
             </td>
             <td class="p-4 align-middle font-medium">${escapeHtml(p.name)}</td>
             <td class="p-4 align-middle">${Number(p.price)}</td>
             <td class="p-4 align-middle capitalize">${escapeHtml(categoryLabel)}</td>
             <td class="p-4 align-middle">${displayStock}</td>
             <td class="p-4 align-middle">
                <span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${isActive ? 'border-transparent bg-primary/10 text-primary' : 'border-transparent bg-muted text-muted-foreground'}">
                    ${isActive ? t(locale, 'admin.products.active') : t(locale, 'admin.products.inactive')}
                </span>
             </td>
             <td class="p-4 align-middle">
                <div class="flex items-center justify-end gap-2 flex-wrap">
                <form action="/admin/product/toggle/${p.id}" method="POST" class="inline-flex">
                   <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                   <input type="hidden" name="is_active" value="${isActive ? 0 : 1}">
                   <button title="${isActive ? t(locale, 'admin.products.hide') : t(locale, 'admin.products.show')}" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 w-8">
                     <i data-lucide="${isActive ? 'eye-off' : 'eye'}" class="h-4 w-4"></i>
                   </button>
                </form>
                <a href="/admin/cards/list/${p.id}" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 px-3">
                  ${t(locale, 'admin.products.manageCards')}
                </a>
                <a href="/admin/product/edit/${p.id}" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 px-3">
                  ${t(locale, 'common.edit')}
                </a>
                <form action="/admin/product/delete/${p.id}" method="POST" class="inline-flex" onsubmit="return confirm('${escapeHtml(t(locale, 'admin.products.confirmDelete'))}');">
                   <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                   <button class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90 h-8 px-3">
                     ${t(locale, 'common.delete')}
                   </button>
                </form>
                </div>
             </td>
        </tr>`;
    }).join('');

    const content = `
        <div class="space-y-6">
          <div class="grid gap-4 md:grid-cols-4">
            ${statsHtml}
          </div>
          <div class="flex items-center justify-between">
              <h1 class="text-3xl font-bold tracking-tight">${t(locale, 'admin.products.title')}</h1>
              <a href="/admin/product/new" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 h-10 px-4 py-2">
                 <i data-lucide="plus" class="mr-2 h-4 w-4"></i>${t(locale, 'admin.products.addNew')}
              </a>
          </div>
          <div class="rounded-md border border-soft bg-card">
              <div class="relative w-full overflow-auto">
                  <table class="w-full caption-bottom text-sm">
                     <thead class="[&_tr]:border-b">
                        <tr class="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.order')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.name')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.price')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.category')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.stock')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.status')}</th>
                          <th class="h-12 px-4 text-right align-middle font-medium text-muted-foreground">${t(locale, 'admin.products.actions')}</th>
                        </tr>
                     </thead>
                     <tbody class="[&_tr:last-child]:border-0">
                        ${tableRows}
                     </tbody>
                  </table>
              </div>
          </div>
        </div>
    `;
    return renderAdminLayout(content, 'products', user, locale, siteSettings);
}

function renderProductForm(product = {}, user, locale, siteSettings) {
    const isEdit = !!product.id;
    const content = `
       <div class="max-w-2xl mx-auto">
          <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm">
             <div class="flex flex-col space-y-1.5 p-6">
                <h3 class="font-semibold tracking-tight text-2xl">${isEdit ? t(locale, 'admin.productForm.editTitle') : t(locale, 'admin.productForm.addTitle')}</h3>
             </div>
             <div class="p-6 pt-0">
               <form action="/admin/product/save" method="POST" class="space-y-4">
                 <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                 ${isEdit ? `<input type="hidden" name="id" value="${product.id}">` : ''}

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="name">${t(locale, 'admin.productForm.nameLabel')}</label>
                    <input id="name" type="text" name="name" value="${product.name || ''}" placeholder="${t(locale, 'admin.productForm.namePlaceholder')}" required class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="price">${t(locale, 'admin.productForm.priceLabel')}</label>
                    <input id="price" type="number" step="0.01" name="price" value="${product.price ?? ''}" placeholder="${t(locale, 'admin.productForm.pricePlaceholder')}" required class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="purchase_limit">${t(locale, 'admin.productForm.purchaseLimitLabel')}</label>
                    <input id="purchase_limit" type="number" name="purchase_limit" value="${product.purchase_limit ?? ''}" placeholder="${t(locale, 'admin.productForm.purchaseLimitPlaceholder')}" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="category">${t(locale, 'admin.productForm.categoryLabel')}</label>
                    <input id="category" type="text" name="category" value="${product.category || ''}" placeholder="${t(locale, 'admin.productForm.categoryPlaceholder')}" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="image">${t(locale, 'admin.productForm.imageLabel')}</label>
                    <input id="image" type="url" name="image" value="${product.image || ''}" placeholder="${t(locale, 'admin.productForm.imagePlaceholder')}" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="description">${t(locale, 'admin.productForm.descLabel')}</label>
                    <textarea id="description" name="description" rows="4" placeholder="${t(locale, 'admin.productForm.descPlaceholder')}" class="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${escapeHtml(product.description || '')}</textarea>
                 </div>

                 <div class="pt-4 flex justify-end gap-2">
                    <a href="/admin" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-4 py-2">${t(locale, 'common.cancel')}</a>
                    <button type="submit" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 h-9 px-4 py-2">${t(locale, 'admin.productForm.saveButton')}</button>
                 </div>
               </form>
             </div>
          </div>
       </div>`;
    return renderAdminLayout(content, 'products', user, locale, siteSettings);
}

function renderAnnouncementForm(announcement = '', user, locale, saved = false, siteSettings) {
    const savedHtml = saved
        ? `<span class="text-sm text-green-500 flex items-center gap-1">
             <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
             </svg>
             ${t(locale, 'admin.settings.saved')}
           </span>`
        : '';

    const content = `
       <div class="max-w-3xl mx-auto">
          <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm tech-card announcement-card">
             <div class="flex flex-col space-y-1.5 p-6">
                <h3 class="font-semibold tracking-tight text-2xl flex items-center gap-2">
                  <svg class="w-5 h-5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"></path>
                  </svg>
                  ${t(locale, 'announcement.title')}
                </h3>
             </div>
             <div class="p-6 pt-0 space-y-4">
               <form action="/admin/announcement/save" method="POST" class="space-y-4">
                 <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                 <textarea name="announcement" rows="4" placeholder="${t(locale, 'announcement.placeholder')}" class="resize-none flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${announcement || ''}</textarea>
                 <div class="flex items-center gap-3">
                   <button class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-foreground text-background hover:bg-foreground/90 h-9 px-4 py-2">
                     ${t(locale, 'announcement.save')}
                   </button>
                   ${savedHtml}
                 </div>
               </form>
               <p class="text-xs text-muted-foreground">${t(locale, 'announcement.hint')}</p>
             </div>
          </div>
       </div>`;
    return renderAdminLayout(content, 'announcement', user, locale, siteSettings);
}

function renderSiteSettingsForm(siteSettings, user, locale, saved = false) {
    const savedHtml = saved
        ? `<span class="text-sm text-green-500 flex items-center gap-1">
             <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
               <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
             </svg>
             ${t(locale, 'admin.settings.saved')}
           </span>`
        : '';

    const content = `
       <div class="max-w-2xl mx-auto">
          <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm">
             <div class="flex flex-col space-y-1.5 p-6">
                <h3 class="font-semibold tracking-tight text-2xl flex items-center gap-2">
                  <i data-lucide="settings" class="h-5 w-5 text-primary"></i>
                  ${t(locale, 'admin.settings.title')}
                </h3>
             </div>
             <div class="p-6 pt-0">
               <form action="/admin/settings/save" method="POST" class="space-y-4">
                 <input type="hidden" name="csrf_token" value="${user.csrf_token}">

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="shop_name">${t(locale, 'admin.settings.shopName')}</label>
                    <input id="shop_name" type="text" name="shop_name" value="${escapeHtml(siteSettings?.shopName || '')}" placeholder="${t(locale, 'admin.settings.shopNamePlaceholder')}" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="site_title">${t(locale, 'admin.settings.siteTitle')}</label>
                    <input id="site_title" type="text" name="site_title" value="${escapeHtml(siteSettings?.siteTitle || '')}" placeholder="${CONFIG.SITE_NAME}" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                 </div>

                 <div class="grid gap-2">
                    <label class="text-sm font-medium leading-none" for="site_description">${t(locale, 'admin.settings.siteDescription')}</label>
                    <textarea id="site_description" name="site_description" rows="3" placeholder="${CONFIG.SITE_DESCRIPTION}" class="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${escapeHtml(siteSettings?.siteDescription || '')}</textarea>
                 </div>

                 <div class="flex items-center gap-3">
                   <button class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-foreground text-background hover:bg-foreground/90 h-9 px-4 py-2">
                     ${t(locale, 'common.save')}
                   </button>
                   ${savedHtml}
                 </div>
               </form>
             </div>
          </div>
       </div>`;
    return renderAdminLayout(content, 'settings', user, locale, siteSettings);
}

function renderCardManager(product, cards, user, locale, siteSettings) {
    const cardItems = cards.length === 0
        ? `<div class="text-center py-10 text-muted-foreground text-sm">${t(locale, 'admin.cards.noCards')}</div>`
        : cards.map(c => `
            <div class="flex items-center justify-between p-2 rounded bg-muted/40 text-sm font-mono gap-2">
              <button type="button" data-copy="${escapeHtml(c.card_key)}" title="${escapeHtml(c.card_key)}" class="truncate max-w-[220px] text-left hover:text-primary">${escapeHtml(truncateText(c.card_key, 30))}</button>
              <form action="/admin/cards/delete/${c.id}?pid=${product.id}" method="POST" onsubmit="return confirm('${escapeHtml(t(locale, 'common.confirm'))}?');">
                <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                <button class="inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:text-destructive hover:bg-destructive/10">
                  <i data-lucide="trash-2" class="h-4 w-4"></i>
                </button>
              </form>
            </div>
          `).join('');

    const content = `
      <div class="space-y-8 max-w-4xl mx-auto">
        <div class="flex items-center justify-between">
          <div>
             <h1 class="text-3xl font-bold tracking-tight">${t(locale, 'admin.cards.title')}: ${escapeHtml(product.name)}</h1>
          </div>
          <div class="text-right">
             <div class="text-2xl font-bold">${cards.length}</div>
             <div class="text-xs text-muted-foreground">${t(locale, 'admin.cards.available')}</div>
          </div>
        </div>

        <div class="grid md:grid-cols-2 gap-8">
           <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm">
               <div class="flex flex-col space-y-1.5 p-6">
                  <h3 class="font-semibold leading-none tracking-tight">${t(locale, 'admin.cards.addCards')}</h3>
               </div>
               <div class="p-6 pt-0">
                   <form action="/admin/cards/save" method="POST" class="space-y-4">
                       <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                       <input type="hidden" name="product_id" value="${product.id}">
                       <textarea name="cards" rows="10" placeholder="${t(locale, 'admin.cards.placeholder')}" class="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" required></textarea>
                       <button class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium bg-foreground text-background hover:bg-foreground/90 h-10 px-4 py-2 w-full">${t(locale, 'common.add')}</button>
                   </form>
               </div>
           </div>

           <div class="rounded-xl border border-soft bg-card text-card-foreground shadow-sm">
               <div class="flex flex-col space-y-1.5 p-6">
                   <h3 class="font-semibold leading-none tracking-tight">${t(locale, 'admin.cards.available')}</h3>
               </div>
               <div class="p-6 pt-0 max-h-[400px] overflow-y-auto space-y-2">
                   ${cardItems}
               </div>
           </div>
        </div>
      </div>
    `;
    return renderAdminLayout(content, 'products', user, locale, siteSettings);
}

function renderAdminOrders(orders, user, locale, siteSettings) {
    const statusBadgeClass = (status) => {
        switch (status) {
            case 'delivered':
                return 'bg-green-500/10 text-green-500 border-green-500/30';
            case 'paid':
                return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30';
            case 'refunded':
                return 'bg-red-500/10 text-red-600 border-red-500/30';
            case 'cancelled':
                return 'bg-muted/40 text-muted-foreground border-border/50';
            default:
                return 'border-border/50 text-muted-foreground';
        }
    };

    const tableRows = orders.map(o => {
        const statusLabel = t(locale, `order.status.${o.status || 'pending'}`) || o.status || 'pending';
        const showRefund = (o.status === 'delivered' || o.status === 'paid') && o.trade_no;
        const cardKey = o.card_key ? escapeHtml(o.card_key) : '';

        return `
        <tr class="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted" data-refund-row="${o.order_id}">
             <td class="p-4 align-middle text-xs font-mono">${o.order_id}</td>
             <td class="p-4 align-middle">
                ${o.username
            ? `<a href="https://linux.do/u/${o.username}" target="_blank" class="font-medium text-sm hover:underline text-primary">${escapeHtml(o.username)}</a>`
            : `<span class="font-medium text-sm text-muted-foreground">${t(locale, 'common.guest')}</span>`}
             </td>
             <td class="p-4 align-middle">${escapeHtml(o.product_name)}</td>
             <td class="p-4 align-middle">${Number(o.amount)}</td>
             <td class="p-4 align-middle">
                <span class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase ${statusBadgeClass(o.status)}">
                   ${statusLabel}
                </span>
             </td>
             <td class="p-4 align-middle">
                ${cardKey ? `<button type="button" data-copy="${cardKey}" title="${cardKey}" class="font-mono text-xs bg-muted/50 px-2 py-1 rounded hover:text-primary">${escapeHtml(truncateText(o.card_key, 15))}</button>` : `<span class="text-muted-foreground">-</span>`}
             </td>
             <td class="p-4 align-middle text-xs text-muted-foreground">
                <time data-date="${o.created_at}" data-format="dateTime" data-placeholder="-"></time>
             </td>
             <td class="p-4 align-middle text-right">
                ${showRefund ? `
                  <div class="flex items-center justify-end gap-2">
                    <form action="${CONFIG.REFUND_URL}" method="POST" target="_blank" data-refund-form data-order-id="${o.order_id}">
                       <input type="hidden" name="pid" value="${CONFIG.MERCHANT_ID}">
                       <input type="hidden" name="key" value="${CONFIG.MERCHANT_KEY}">
                       <input type="hidden" name="trade_no" value="${o.trade_no}">
                       <input type="hidden" name="money" value="${o.amount}">
                       <button type="submit" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 px-3">
                         <i data-lucide="external-link" class="h-3 w-3 mr-1"></i>${t(locale, 'admin.orders.refund')}
                       </button>
                    </form>
                    <form action="/admin/order/mark-refunded/${o.order_id}" method="POST" class="inline hidden" data-mark-refunded>
                       <input type="hidden" name="csrf_token" value="${user.csrf_token}">
                       <button type="submit" class="inline-flex items-center justify-center whitespace-nowrap rounded-md text-xs font-medium bg-foreground text-background hover:bg-foreground/90 h-8 px-3">
                         <i data-lucide="check-circle" class="h-3 w-3 mr-1"></i>${t(locale, 'admin.orders.markRefunded')}
                       </button>
                    </form>
                  </div>` : ''}
             </td>
        </tr>`;
    }).join('');

    const content = `
        <div class="space-y-6">
          <div class="flex items-center justify-between">
              <h1 class="text-3xl font-bold tracking-tight">${t(locale, 'admin.orders.title')}</h1>
          </div>
          <div class="rounded-md border border-soft bg-card">
              <div class="relative w-full overflow-auto">
                  <table class="w-full caption-bottom text-sm">
                     <thead class="[&_tr]:border-b">
                        <tr class="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.orderId')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.user')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.product')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.amount')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.status')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.cardKey')}</th>
                          <th class="h-12 px-4 text-left align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.date')}</th>
                          <th class="h-12 px-4 text-right align-middle font-medium text-muted-foreground">${t(locale, 'admin.orders.actions')}</th>
                        </tr>
                     </thead>
                     <tbody class="[&_tr:last-child]:border-0">
                        ${tableRows}
                     </tbody>
                  </table>
              </div>
          </div>
        </div>
        <script>
          const refundParams = new URLSearchParams(window.location.search);
          if (refundParams.get('refunded') === '1') {
            window.showToast(window.__I18N?.refundSuccess || 'Order marked as refunded');
          }

          document.addEventListener('submit', (event) => {
            const markForm = event.target.closest('[data-mark-refunded]');
            if (markForm) {
              if (!confirm(window.__I18N?.refundVerify || 'Verify refund?')) {
                event.preventDefault();
              }
              return;
            }

            const refundForm = event.target.closest('[data-refund-form]');
            if (!refundForm) return;
            const orderId = refundForm.getAttribute('data-order-id');
            if (!confirm(window.__I18N?.refundConfirm || 'Open refund page?')) {
              event.preventDefault();
              return;
            }
            const row = orderId ? document.querySelector('[data-refund-row=\"' + orderId + '\"]') : null;
            const mark = row ? row.querySelector('[data-mark-refunded]') : null;
            if (mark) {
              mark.classList.remove('hidden');
            }
            window.showToast(window.__I18N?.refundInfo || 'Refund info');
          });
        </script>
    `;
    return renderAdminLayout(content, 'orders', user, locale, siteSettings);
}

// ==================== Database Helpers ====================

async function getProducts(db, options = {}) {
    const { includeInactive = false } = options;
    const whereClause = includeInactive ? '' : 'WHERE p.is_active = 1';

    const { results } = await db.prepare(`
        SELECT p.*,
        (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 0 AND (c.reserved_at IS NULL OR c.reserved_at < datetime('now', ?))) AS stock,
        (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 1) AS sold,
        (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 0 AND c.reserved_at IS NOT NULL AND c.reserved_at >= datetime('now', ?)) AS reserved,
        (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r WHERE r.product_id = p.id) AS rating,
        (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count
        FROM products p
        ${whereClause}
        ORDER BY p.sort_order ASC, p.created_at DESC
    `).bind(RESERVATION_INTERVAL, RESERVATION_INTERVAL).all();
    return results;
}
async function getProduct(db, id, options = {}) {
    const { includeInactive = false } = options;
    const whereClause = includeInactive ? 'p.id = ?' : 'p.id = ? AND p.is_active = 1';

    return await db.prepare(`
        SELECT p.*,
        (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 0 AND (c.reserved_at IS NULL OR c.reserved_at < datetime('now', ?))) AS stock,
        (SELECT COUNT(*) FROM cards c WHERE c.product_id = p.id AND c.is_used = 0 AND c.reserved_at IS NOT NULL AND c.reserved_at >= datetime('now', ?)) AS reserved,
        (SELECT COALESCE(AVG(r.rating), 0) FROM reviews r WHERE r.product_id = p.id) AS rating,
        (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id) AS review_count
        FROM products p
        WHERE ${whereClause}
    `).bind(RESERVATION_INTERVAL, RESERVATION_INTERVAL, id).first();
}
async function getOrders(db, limit = 50) {
    const { results } = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    return results;
}
async function getDashboardStats(db) {
    const [today, week, month, total] = await Promise.all([
        db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
            FROM orders
            WHERE status = 'delivered'
              AND paid_at IS NOT NULL
              AND paid_at >= datetime('now', 'start of day')
        `).first(),
        db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
            FROM orders
            WHERE status = 'delivered'
              AND paid_at IS NOT NULL
              AND paid_at >= datetime('now', '-7 days')
        `).first(),
        db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
            FROM orders
            WHERE status = 'delivered'
              AND paid_at IS NOT NULL
              AND paid_at >= datetime('now', 'start of month')
        `).first(),
        db.prepare(`
            SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as revenue
            FROM orders
            WHERE status = 'delivered'
        `).first()
    ]);

    const normalize = (row) => ({
        count: Number(row?.count || 0),
        revenue: Number(row?.revenue || 0)
    });

    return {
        today: normalize(today),
        week: normalize(week),
        month: normalize(month),
        total: normalize(total)
    };
}
async function getUnusedCards(db, pid) {
    const { results } = await db.prepare(`
        SELECT * FROM cards
        WHERE product_id = ?
          AND is_used = 0
          AND (reserved_at IS NULL OR reserved_at < datetime('now', ?))
        ORDER BY created_at DESC
    `).bind(pid, RESERVATION_INTERVAL).all();
    return results;
}

async function getSetting(db, key) {
    const result = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return result ? result.value : null;
}

async function setSetting(db, key, value) {
    await db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).bind(key, value).run();
}

async function getSiteSettings(db) {
    const { results } = await db.prepare(`
        SELECT key, value FROM settings
        WHERE key IN ('site_title', 'site_description', 'shop_name')
    `).all();
    const map = {};
    results.forEach(row => {
        map[row.key] = row.value;
    });
    return {
        siteTitle: map.site_title || CONFIG.SITE_NAME,
        siteDescription: map.site_description || CONFIG.SITE_DESCRIPTION,
        shopName: map.shop_name || ''
    };
}

async function isLoginUsersBackfilled(db) {
    const result = await getSetting(db, 'login_users_backfilled');
    return result === '1';
}

async function markLoginUsersBackfilled(db) {
    await setSetting(db, 'login_users_backfilled', '1');
}

async function backfillLoginUsers(db) {
    const done = await isLoginUsersBackfilled(db);
    if (done) return;

    await db.prepare(`
        INSERT OR IGNORE INTO login_users (user_id, username, created_at, last_login_at)
        SELECT user_id, MAX(username) AS username, datetime('now'), datetime('now')
        FROM (
            SELECT user_id, username FROM orders WHERE user_id IS NOT NULL AND user_id <> ''
            UNION ALL
            SELECT user_id, username FROM reviews WHERE user_id IS NOT NULL AND user_id <> ''
        )
        GROUP BY user_id
    `).run();

    await markLoginUsersBackfilled(db);
}

async function recordLoginUser(db, userId, username) {
    if (!userId) return;
    await db.prepare(`
        INSERT INTO login_users (user_id, username, created_at, last_login_at)
        VALUES (?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, last_login_at = datetime('now')
    `).bind(userId, username || null).run();
}

async function getVisitorCount(db) {
    await backfillLoginUsers(db);
    const result = await db.prepare('SELECT COUNT(*) as count FROM login_users').first();
    return result?.count || 0;
}

async function getProductReviews(db, productId) {
    const { results } = await db.prepare(`
        SELECT r.*,
               (SELECT s.avatar_url
                FROM sessions s
                WHERE (s.user_id = r.user_id OR s.username = r.username)
                ORDER BY s.created_at DESC
                LIMIT 1) AS avatar_url
        FROM reviews r
        WHERE r.product_id = ?
        ORDER BY r.created_at DESC
    `).bind(productId).all();
    return results;
}

async function getProductRating(db, productId) {
    const result = await db.prepare(`
        SELECT COALESCE(AVG(rating), 0) as avg, COUNT(*) as count
        FROM reviews
        WHERE product_id = ?
    `).bind(productId).first();
    return {
        average: result?.avg || 0,
        count: result?.count || 0
    };
}

async function canUserReview(db, userId, username, productId) {
    const conditions = [];
    const params = [productId];

    if (userId) {
        conditions.push('user_id = ?');
        params.push(userId);
    }
    if (username) {
        conditions.push('username = ?');
        params.push(username);
    }

    if (!conditions.length) return { canReview: false };

    const { results } = await db.prepare(`
        SELECT order_id FROM orders
        WHERE product_id = ?
          AND status = 'delivered'
          AND (${conditions.join(' OR ')})
        ORDER BY created_at DESC
    `).bind(...params).all();

    for (const order of results) {
        const existing = await db.prepare('SELECT id FROM reviews WHERE order_id = ?').bind(order.order_id).first();
        if (!existing) {
            return { canReview: true, orderId: order.order_id };
        }
    }

    return { canReview: false };
}

async function createReview(db, data) {
    await db.prepare(`
        INSERT INTO reviews (product_id, order_id, user_id, username, rating, comment, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(data.productId, data.orderId, data.userId, data.username, data.rating, data.comment || null).run();
}

async function cancelExpiredOrders(env, filters = {}) {
    const productId = filters.productId || null;
    const userId = filters.userId || null;
    const orderId = filters.orderId || null;

    const { results } = await env.DB.prepare(`
        SELECT order_id FROM orders
        WHERE status = 'pending'
          AND created_at < datetime('now', ?)
          AND (? IS NULL OR product_id = ?)
          AND (? IS NULL OR user_id = ?)
          AND (? IS NULL OR order_id = ?)
    `).bind(PAYMENT_TIMEOUT_INTERVAL, productId, productId, userId, userId, orderId, orderId).all();

    const orderIds = results.map(row => row.order_id).filter(Boolean);
    if (!orderIds.length) return [];

    const placeholders = orderIds.map(() => '?').join(', ');

    await env.DB.prepare(`
        UPDATE orders
        SET status = 'cancelled'
        WHERE status = 'pending' AND order_id IN (${placeholders})
    `).bind(...orderIds).run();

    await env.DB.prepare(`
        UPDATE cards
        SET reserved_order_id = NULL, reserved_at = NULL
        WHERE reserved_order_id IN (${placeholders}) AND is_used = 0
    `).bind(...orderIds).run();

    return orderIds;
}

async function reserveCardForOrder(env, productId, orderId) {
    const result = await env.DB.prepare(`
        UPDATE cards
        SET reserved_order_id = ?, reserved_at = datetime('now')
        WHERE id = (
            SELECT id FROM cards
            WHERE product_id = ?
              AND is_used = 0
              AND (reserved_at IS NULL OR reserved_at < datetime('now', ?))
            LIMIT 1
        )
          AND is_used = 0
          AND (reserved_at IS NULL OR reserved_at < datetime('now', ?))
    `).bind(orderId, productId, RESERVATION_INTERVAL, RESERVATION_INTERVAL).run();

    return (result.meta?.changes || 0) > 0;
}

async function getReservedCardForOrder(env, orderId) {
    return await env.DB.prepare(`
        SELECT * FROM cards
        WHERE reserved_order_id = ? AND is_used = 0
        LIMIT 1
    `).bind(orderId).first();
}

async function getAvailableCard(env, productId) {
    return await env.DB.prepare(`
        SELECT * FROM cards
        WHERE product_id = ?
          AND is_used = 0
          AND (reserved_at IS NULL OR reserved_at < datetime('now', ?))
        LIMIT 1
    `).bind(productId, RESERVATION_INTERVAL).first();
}

// ==================== Workers Logic ====================

// Auth Middleware
async function getSession(request, env) {
    const cookie = request.headers.get('Cookie');
    if (!cookie) return null;
    const match = cookie.match(new RegExp(`${CONFIG.COOKIE_SESSION}=([^;]+)`));
    if (!match) return null;
    const sessionId = match[1];

    // Check D1
    const session = await env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > datetime("now")').bind(sessionId).first();
    return session;
}

async function isAdmin(request, env) {
    const user = await getSession(request, env);
    if (!user) return false;
    const lowerAdmins = CONFIG.ADMIN_USERS.map(u => u.toLowerCase());
    return lowerAdmins.includes(user.username.toLowerCase());
}


const HTML_HEADER = { 'Content-Type': 'text/html; charset=utf-8' };

function getBuyErrorMessage(code) {
    if (!code) return null;
    switch (code) {
        case 'limit':
            return 'Purchase limit reached for this product.';
        case 'stock_locked':
            return 'Stock is temporarily locked. Please try again.';
        case 'out_of_stock':
            return 'Out of stock.';
        case 'not_found':
            return 'Product not found.';
        case 'csrf':
            return 'CSRF authorization failed.';
        case 'login':
            return 'Login required to purchase.';
        default:
            return 'Unable to create order. Please try again.';
    }
}

export default {
    async fetch(request, env, ctx) {
        // Initialize Configuration from Env on first load
        if (!CONFIG) {
            CONFIG = { ...DEFAULT_CONFIG, OAUTH: { ...DEFAULT_CONFIG.OAUTH } }; // Shallow copy + deep copy OAUTH
            if (env.MERCHANT_ID) CONFIG.MERCHANT_ID = env.MERCHANT_ID;
            if (env.MERCHANT_KEY) CONFIG.MERCHANT_KEY = env.MERCHANT_KEY;

            if (env.OAUTH_CLIENT_ID) CONFIG.OAUTH.CLIENT_ID = env.OAUTH_CLIENT_ID;
            if (env.OAUTH_CLIENT_SECRET) CONFIG.OAUTH.CLIENT_SECRET = env.OAUTH_CLIENT_SECRET;
            if (env.OAUTH_REDIRECT_URI) CONFIG.OAUTH.REDIRECT_URI = env.OAUTH_REDIRECT_URI;

            if (env.ADMIN_USERS) CONFIG.ADMIN_USERS = env.ADMIN_USERS.split(',');
        }

        const url = new URL(request.url);
        const path = url.pathname;
        const locale = resolveLocale(request);
        let cachedSiteSettings = null;
        const ensureSiteSettings = async () => {
            if (!cachedSiteSettings) {
                cachedSiteSettings = await getSiteSettings(env.DB);
            }
            return cachedSiteSettings;
        };

        try {
            await ensureSchema(env.DB);
            // Auth Routes
            if (path === '/auth/login') return handleAuthLogin(request);
            if (path === '/authcallback') return await handleAuthCallback(request, env);
            if (path === '/auth/logout') return await handleAuthLogout(request, env);

            // Public Routes
            if (path === '/') {
                await cancelExpiredOrders(env);
                const user = await getSession(request, env);
                const siteSettings = await ensureSiteSettings();
                const [products, announcement, visitorCount] = await Promise.all([
                    getProducts(env.DB),
                    getSetting(env.DB, 'announcement'),
                    getVisitorCount(env.DB)
                ]);
                return new Response(renderHomePage(products, { user, locale, announcement, visitorCount, siteSettings }), { headers: HTML_HEADER });
            }
            if (path.startsWith('/buy/')) {
                const productId = path.split('/').pop();
                await cancelExpiredOrders(env, { productId });
                const p = await getProduct(env.DB, productId);
                const user = await getSession(request, env);
                if (!p) return new Response('Not Found', { status: 404 });

                const siteSettings = await ensureSiteSettings();
                const [reviews, ratingSummary] = await Promise.all([
                    getProductReviews(env.DB, productId),
                    getProductRating(env.DB, productId)
                ]);

                let canReviewResult = { canReview: false, orderId: null };
                if (user) {
                    canReviewResult = await canUserReview(env.DB, user.user_id, user.username, productId);
                }

                const errorCode = url.searchParams.get('error');
                let errorMessage = null;
                if (errorCode === 'limit') errorMessage = t(locale, 'buy.limitExceeded');
                if (errorCode === 'stock_locked') errorMessage = t(locale, 'buy.stockLocked');
                if (errorCode === 'out_of_stock') errorMessage = t(locale, 'buy.outOfStock');
                if (errorCode === 'not_found') errorMessage = t(locale, 'buy.productNotFound');
                if (errorCode === 'csrf') errorMessage = t(locale, 'common.error');

                return new Response(renderBuyPage(p, user, {
                    locale,
                    errorMessage,
                    reviews,
                    averageRating: ratingSummary.average,
                    reviewCount: ratingSummary.count,
                    canReview: canReviewResult.canReview,
                    reviewOrderId: canReviewResult.orderId,
                    siteSettings
                }), { headers: HTML_HEADER });
            }
            if (path === '/order/create' && request.method === 'POST') return await handleCreateOrder(request, env);
            if (path.startsWith('/order/') && request.method === 'GET') {
                const orderId = path.replace('/order/', '');
                const orderView = await getOrderViewData(request, env, orderId);
                if (!orderView) return new Response('Not Found', { status: 404 });
                const siteSettings = await ensureSiteSettings();
                return new Response(renderOrderPage(orderView.order, {
                    showKey: orderView.showKey,
                    user: orderView.user,
                    locale,
                    siteSettings
                }), { headers: HTML_HEADER });
            }
            if (path === '/review/create' && request.method === 'POST') return await handleCreateReview(request, env);
            if (path === '/notify') return await handleNotify(request, env);
            if (path === '/return' || path === '/callback' || path.startsWith('/callback/')) return await handleReturn(request, env);

            // Query Order & History
            if (path === '/query' || path === '/orders') {
                const user = await getSession(request, env);
                if (!user) {
                    return Response.redirect(`${url.origin}/auth/login`, 302);
                }
                await cancelExpiredOrders(env, { userId: user.user_id });
                const siteSettings = await ensureSiteSettings();
                const { results } = await env.DB.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(user.user_id).all();
                return new Response(renderQueryPage(results, { user, locale, siteSettings }), { headers: HTML_HEADER });
            }


            // Admin Routes
            if (path.startsWith('/admin')) {
                if (!await isAdmin(request, env)) {
                    return new Response('Access Denied. Please Login with an Authorized Linux DO Account.', { status: 403, headers: HTML_HEADER });
                }
                const user = await getSession(request, env); // Get user for CSRF Token
                const siteSettings = await ensureSiteSettings();

                // Dashboard
                if (path === '/admin') {
                    return new Response(renderAdminDashboardWithUser(await getProducts(env.DB, { includeInactive: true }), user, locale, await getDashboardStats(env.DB), siteSettings), { headers: HTML_HEADER });
                }
                if (path === '/admin/orders') {
                    await cancelExpiredOrders(env);
                    return new Response(renderAdminOrders(await getOrders(env.DB), user, locale, siteSettings), { headers: HTML_HEADER });
                }
                if (path === '/admin/announcement') {
                    const announcement = await getSetting(env.DB, 'announcement');
                    const saved = url.searchParams.get('saved') === '1';
                    return new Response(renderAnnouncementForm(announcement || '', user, locale, saved, siteSettings), { headers: HTML_HEADER });
                }
                if (path === '/admin/announcement/save' && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });
                    await setSetting(env.DB, 'announcement', fd.get('announcement') || '');
                    return Response.redirect(`${url.origin}/admin/announcement?saved=1`, 302);
                }
                if (path === '/admin/settings') {
                    const saved = url.searchParams.get('saved') === '1';
                    return new Response(renderSiteSettingsForm(siteSettings, user, locale, saved), { headers: HTML_HEADER });
                }
                if (path === '/admin/settings/save' && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const shopName = String(fd.get('shop_name') || '').trim();
                    const siteTitle = String(fd.get('site_title') || '').trim();
                    const siteDescription = String(fd.get('site_description') || '').trim();

                    await Promise.all([
                        setSetting(env.DB, 'shop_name', shopName),
                        setSetting(env.DB, 'site_title', siteTitle),
                        setSetting(env.DB, 'site_description', siteDescription)
                    ]);
                    return Response.redirect(`${url.origin}/admin/settings?saved=1`, 302);
                }
                if (path.startsWith('/admin/order/mark-refunded/') && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const orderId = path.replace('/admin/order/mark-refunded/', '');
                    const order = await env.DB.prepare('SELECT status FROM orders WHERE order_id = ?').bind(orderId).first();
                    if (!order) return new Response('Order not found', { status: 404 });
                    if (order.status !== 'delivered' && order.status !== 'paid') return new Response('Order status not refundable', { status: 400 });

                    await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE order_id = ?").bind(orderId).run();
                    return Response.redirect(`${url.origin}/admin/orders?refunded=1`, 302);
                }

                // Product Editor
                if (path === '/admin/product/new') return new Response(renderProductForm({}, user, locale, siteSettings), { headers: HTML_HEADER });
                if (path.startsWith('/admin/product/edit/')) {
                    const p = await getProduct(env.DB, path.replace('/admin/product/edit/', ''), { includeInactive: true });
                    return new Response(renderProductForm(p, user, locale, siteSettings), { headers: HTML_HEADER });
                }
                if (path === '/admin/product/reorder' && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const productId = fd.get('product_id');
                    const direction = fd.get('direction');
                    if (!productId || (direction !== 'up' && direction !== 'down')) {
                        return Response.redirect(`${url.origin}/admin`, 302);
                    }

                    const products = await getProducts(env.DB, { includeInactive: true });
                    const ids = products.map(p => p.id);
                    const idx = ids.indexOf(productId);
                    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
                    if (idx >= 0 && targetIdx >= 0 && targetIdx < ids.length) {
                        [ids[idx], ids[targetIdx]] = [ids[targetIdx], ids[idx]];
                        const stmt = env.DB.prepare('UPDATE products SET sort_order = ? WHERE id = ?');
                        await env.DB.batch(ids.map((id, index) => stmt.bind(index, id)));
                    }
                    return Response.redirect(`${url.origin}/admin`, 302);
                }
                if (path.startsWith('/admin/product/toggle/') && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const id = path.replace('/admin/product/toggle/', '');
                    const isActive = fd.get('is_active') === '1' ? 1 : 0;
                    await env.DB.prepare('UPDATE products SET is_active = ? WHERE id = ?').bind(isActive, id).run();
                    return Response.redirect(`${url.origin}/admin`, 302);
                }
                // Save Product
                if (path === '/admin/product/save' && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const id = fd.get('id') || `prod_${Date.now()}`;
                    const existing = await env.DB.prepare('SELECT is_active, sort_order FROM products WHERE id = ?').bind(id).first();
                    const purchaseLimitRaw = fd.get('purchase_limit');
                    const purchaseLimit = purchaseLimitRaw ? parseInt(purchaseLimitRaw, 10) : null;
                    const sortOrderRaw = fd.get('sort_order');
                    const sortOrder = sortOrderRaw ? parseInt(sortOrderRaw, 10) : (existing?.sort_order ?? 0);
                    const isActive = fd.has('is_active') ? 1 : (existing ? Number(existing.is_active) : 1);

                    await env.DB.prepare(`
                        INSERT INTO products (id, name, description, price, category, image, purchase_limit, sort_order, is_active)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                          name = excluded.name,
                          description = excluded.description,
                          price = excluded.price,
                          category = excluded.category,
                          image = excluded.image,
                          purchase_limit = excluded.purchase_limit,
                          sort_order = excluded.sort_order,
                          is_active = excluded.is_active
                    `).bind(
                        id,
                        fd.get('name'),
                        fd.get('description') || '',
                        fd.get('price'),
                        fd.get('category') || 'general',
                        fd.get('image') || '',
                        purchaseLimit && purchaseLimit > 0 ? purchaseLimit : null,
                        sortOrder,
                        isActive
                    ).run();

                    return Response.redirect(`${url.origin}/admin`, 302);
                }
                // Delete Product
                if (path.startsWith('/admin/product/delete/') && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const id = path.replace('/admin/product/delete/', '');
                    // Delete associated cards first then product
                    await env.DB.batch([
                        env.DB.prepare('DELETE FROM cards WHERE product_id = ?').bind(id),
                        env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id)
                    ]);
                    return Response.redirect(`${url.origin}/admin`, 302);
                }

                // Cards Manager
                if (path.startsWith('/admin/cards/list/')) {
                    const pid = path.replace('/admin/cards/list/', '');
                    const p = await getProduct(env.DB, pid, { includeInactive: true });
                    const cards = await getUnusedCards(env.DB, pid);
                    return new Response(renderCardManager(p, cards, user, locale, siteSettings), { headers: HTML_HEADER });
                }
                // Add Cards
                if (path === '/admin/cards/save' && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const productId = fd.get('product_id');
                    const cards = fd.get('cards').split('\n').map(c => c.trim()).filter(c => c);
                    if (cards.length > 0) {
                        const stmt = env.DB.prepare('INSERT INTO cards (product_id, card_key) VALUES (?, ?)');
                        await env.DB.batch(cards.map(c => stmt.bind(productId, c)));
                    }
                    return Response.redirect(`${url.origin}/admin/cards/list/${productId}`, 302);
                }
                // Delete Card
                if (path.startsWith('/admin/cards/delete/') && request.method === 'POST') {
                    const fd = await request.formData();
                    if (fd.get('csrf_token') !== user.csrf_token) return new Response('CSRF Token Mismatch', { status: 403 });

                    const id = path.split('/')[4];
                    const pid = url.searchParams.get('pid');
                    const reserved = await env.DB.prepare(`
                        SELECT id FROM cards
                        WHERE id = ? AND reserved_at IS NOT NULL AND reserved_at >= datetime('now', ?)
                    `).bind(id, RESERVATION_INTERVAL).first();
                    if (reserved) return new Response('Card is reserved. Try again later.', { status: 409 });

                    await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(id).run();
                    return Response.redirect(`${url.origin}/admin/cards/list/${pid}`, 302);
                }
            }

            return new Response('Page Not Found', { status: 404 });

        } catch (e) {
            return new Response('Error: ' + e.message, { status: 500 });
        }
    },
    async scheduled(event, env, ctx) {
        try {
            await ensureSchema(env.DB);
            await cancelExpiredOrders(env);
        } catch (error) {
            console.error('scheduled cancelExpiredOrders error', error);
        }
    }
};

// ==================== Logic Handlers ====================

async function getOrderViewData(request, env, orderId) {
    if (!orderId) return null;

    await cancelExpiredOrders(env, { orderId });

    const order = await env.DB.prepare('SELECT * FROM orders WHERE order_id = ?').bind(orderId).first();
    if (!order) return null;

    const user = await getSession(request, env);
    let showKey = false;

    const cookie = request.headers.get('Cookie') || '';
    const pendingMatch = cookie.match(/ldc_pending_order=([^;]+)/);
    if (pendingMatch && pendingMatch[1] === orderId) showKey = true;

    if (user && (order.user_id === user.user_id || order.username === user.username)) {
        showKey = true;
    }

    return { order, user, showKey };
}

function renderCallbackPage({ locale, orderId, params = {}, user, siteSettings }) {
    const hasOrderId = Boolean(orderId);
    const safeOrderId = hasOrderId ? encodeURIComponent(orderId) : '';
    const debugInfo = escapeHtml(JSON.stringify(params, null, 2));
    const redirectScript = hasOrderId
        ? `<script>
            setTimeout(() => {
              window.location.replace('/order/${safeOrderId}');
            }, 600);
          </script>`
        : '';

    const content = hasOrderId
        ? `<div class="flex flex-col items-center justify-center min-h-[50vh] gap-4">
             <i data-lucide="loader-2" class="h-8 w-8 animate-spin text-primary"></i>
             <p class="text-muted-foreground">${t(locale, 'callback.processing')}</p>
           </div>`
        : `<div class="container py-12 flex flex-col items-center gap-6">
             <h1 class="text-2xl font-bold text-destructive">${t(locale, 'callback.failedTitle')}</h1>
             <p class="text-muted-foreground text-center">${t(locale, 'callback.failedMessage')}</p>
             <div class="w-full max-w-md bg-muted p-4 rounded-lg overflow-auto font-mono text-xs">
               <p class="font-bold mb-2">${t(locale, 'callback.debugTitle')}</p>
               <pre>${debugInfo}</pre>
             </div>
             <div class="flex gap-4">
               <a href="/orders" class="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90">${t(locale, 'callback.goOrders')}</a>
               <a href="/" class="px-4 py-2 border rounded-md hover:bg-muted">${t(locale, 'callback.goHome')}</a>
             </div>
           </div>`;

    const meta = { siteTitle: siteSettings?.siteTitle || CONFIG.SITE_NAME, description: siteSettings?.siteDescription || CONFIG.SITE_DESCRIPTION };
    return `<!DOCTYPE html><html lang="${locale}" class="h-full"><head>${getCommonHead(t(locale, 'callback.processing'), locale, meta)}</head>
    <body class="min-h-screen bg-background font-sans antialiased">
      <div class="relative flex min-h-screen flex-col">
        ${renderHeader({ user, locale, siteSettings })}
        <main class="container py-12">
          ${content}
        </main>
        ${renderFooter(locale)}
      </div>
      ${redirectScript}
    </body></html>`;
}

function renderQueryPage(orders = [], { user, locale, siteSettings }) {
    const statusBadgeClass = (status) => {
        switch (status) {
            case 'delivered':
                return 'bg-green-500/10 text-green-500 border-green-500/30';
            case 'paid':
                return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/30';
            case 'cancelled':
                return 'bg-red-500/10 text-red-600 border-red-500/30';
            case 'refunded':
                return 'bg-purple-500/10 text-purple-600 border-purple-500/30';
            default:
                return 'border-border/50 text-muted-foreground';
        }
    };

    const meta = { siteTitle: siteSettings?.siteTitle || CONFIG.SITE_NAME, description: siteSettings?.siteDescription || CONFIG.SITE_DESCRIPTION };
    return `<!DOCTYPE html><html lang="${locale}" class="h-full"><head>${getCommonHead(t(locale, 'orders.title'), locale, meta)}</head>
    <body class="min-h-screen bg-background font-sans antialiased">
      <div class="relative flex min-h-screen flex-col">
        ${renderHeader({ user, locale, siteSettings })}
        <main class="container py-12">
          <div class="flex items-center justify-between mb-8">
            <h1 class="text-3xl font-bold tracking-tight">${t(locale, 'orders.title')}</h1>
            <p class="text-muted-foreground">${orders.length} orders</p>
          </div>
          <div class="grid gap-4">
            ${orders.length > 0 ? orders.map(order => `
              <a href="/order/${order.order_id}">
                <div class="rounded-lg border hover:border-primary/50 transition-colors">
                  <div class="flex items-center p-6 gap-4">
                    <div class="h-12 w-12 rounded-full bg-muted flex items-center justify-center shrink-0">
                      <i data-lucide="package" class="h-6 w-6 text-muted-foreground"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between mb-1">
                        <h3 class="font-semibold truncate">${escapeHtml(order.product_name)}</h3>
                        <span class="font-bold">${Number(order.amount)} ${t(locale, 'common.credits')}</span>
                      </div>
                      <div class="flex items-center justify-between text-sm text-muted-foreground">
                        <span class="font-mono">${order.order_id}</span>
                        <time data-date="${order.created_at}" data-format="dateTime" data-placeholder="-"></time>
                      </div>
                    </div>
                    <span class="ml-2 uppercase text-xs tracking-wider px-2.5 py-1 rounded-full border ${statusBadgeClass(order.status)}">
                      ${t(locale, `order.status.${order.status || 'pending'}`)}
                    </span>
                  </div>
                </div>
              </a>
            `).join('') : `
              <div class="text-center py-20 rounded-lg border border-dashed">
                <div class="flex justify-center mb-4">
                  <i data-lucide="search" class="h-10 w-10 text-muted-foreground/50"></i>
                </div>
                <h3 class="font-semibold text-lg">${t(locale, 'orders.noOrders')}</h3>
                <p class="text-muted-foreground mb-6"></p>
                <a href="/" class="text-primary hover:underline">${t(locale, 'orders.browseProducts')}</a>
              </div>
            `}
          </div>
        </main>
        ${renderFooter(locale)}
      </div>
    </body></html>`;
}


async function handleCreateOrder(request, env) {
    const user = await getSession(request, env);
    if (!user) return new Response('Login Required', { status: 401 });

    const formData = await request.formData();
    const productId = formData.get('product_id');
    const url = new URL(request.url);
    // Verify CSRF
    if (formData.get('csrf_token') !== user.csrf_token) {
        return Response.redirect(`${url.origin}/buy/${productId}?error=csrf`, 302);
    }

    await cancelExpiredOrders(env, { productId });

    const product = await getProduct(env.DB, productId);
    if (!product) return new Response('Product not found', { status: 404 });

    const emailRaw = formData.get('email');
    const email = emailRaw && String(emailRaw).trim() ? String(emailRaw).trim() : null;

    if (product.purchase_limit && product.purchase_limit > 0) {
        const conditions = [];
        const params = [product.id];

        if (user?.user_id) {
            conditions.push('user_id = ?');
            params.push(user.user_id);
        }
        if (email) {
            conditions.push('email = ?');
            params.push(email);
        }

        if (conditions.length) {
            const countResult = await env.DB.prepare(`
                SELECT COUNT(*) as count FROM orders
                WHERE product_id = ?
                  AND status IN ('paid', 'delivered')
                  AND (${conditions.join(' OR ')})
            `).bind(...params).first();

            if ((countResult?.count || 0) >= product.purchase_limit) {
                return Response.redirect(`${url.origin}/buy/${productId}?error=limit`, 302);
            }
        }
    }

    if (product.stock <= 0) {
        const errorCode = product.reserved > 0 ? 'stock_locked' : 'out_of_stock';
        return Response.redirect(`${url.origin}/buy/${productId}?error=${errorCode}`, 302);
    }

    const orderId = generateOrderId();

    const reserved = await reserveCardForOrder(env, productId, orderId);
    if (!reserved) {
        return Response.redirect(`${url.origin}/buy/${productId}?error=stock_locked`, 302);
    }

    try {
        await env.DB.prepare(`
            INSERT INTO orders (order_id, product_id, product_name, amount, email, status, user_id, username, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))
        `).bind(orderId, product.id, product.name, product.price,
            email,
            user ? user.user_id : null, user ? user.username : null).run();
    } catch (error) {
        await env.DB.prepare(`
            UPDATE cards
            SET reserved_order_id = NULL, reserved_at = NULL
            WHERE reserved_order_id = ?
        `).bind(orderId).run();
        throw error;
    }

    const payParams = {
        pid: CONFIG.MERCHANT_ID, type: 'epay', out_trade_no: orderId,
        notify_url: `${url.origin}/notify`, return_url: `${url.origin}/callback/${orderId}`,
        name: product.name, money: Number(product.price).toFixed(2), sign_type: 'MD5'
    };
    payParams.sign = await generateSign(payParams, CONFIG.MERCHANT_KEY);

    // Auto-submit form for POST request
    const html = `<!DOCTYPE html><html><body onload="document.forms[0].submit()">
    <form action="${CONFIG.PAY_URL}" method="POST">
       ${Object.entries(payParams).map(([k, v]) => `<input type="hidden" name="${k}" value="${v}">`).join('')}
    </form>
    </body></html>`;

    // Handle Session Cookies (History + Pending)
    const headers = new Headers(HTML_HEADER);

    // 1. Pending Order (for immediate callback). Session only.
    headers.append('Set-Cookie', `ldc_pending_order=${orderId}; Path=/; Secure; SameSite=Lax`);

    return new Response(html, { headers });
}

async function handleCreateReview(request, env) {
    const user = await getSession(request, env);
    if (!user) return new Response('Login Required', { status: 401 });

    const formData = await request.formData();
    if (formData.get('csrf_token') !== user.csrf_token) return new Response('CSRF Authorization Failed', { status: 403 });

    const productId = formData.get('product_id');
    const orderId = formData.get('order_id');
    const rating = parseInt(formData.get('rating'), 10);
    const comment = formData.get('comment');

    if (!productId || !orderId || !rating || rating < 1 || rating > 5) {
        return new Response('Invalid review data', { status: 400 });
    }

    const order = await env.DB.prepare(`
        SELECT * FROM orders
        WHERE order_id = ? AND product_id = ? AND status = 'delivered'
    `).bind(orderId, productId).first();

    if (!order || (order.user_id !== user.user_id && order.username !== user.username)) {
        return new Response('Review not allowed', { status: 403 });
    }

    const existing = await env.DB.prepare('SELECT id FROM reviews WHERE order_id = ?').bind(orderId).first();
    if (!existing) {
        await createReview(env.DB, {
            productId,
            orderId,
            userId: order.user_id || user.user_id,
            username: order.username || user.username,
            rating,
            comment
        });
    }

    const url = new URL(request.url);
    return Response.redirect(`${url.origin}/buy/${productId}`, 302);
}

async function handleNotify(request, env) {
    let params = {};
    if (request.method === 'POST') {
        const ct = request.headers.get('content-type') || '';
        if (ct.includes('form')) (await request.formData()).forEach((v, k) => params[k] = v);
        else new URLSearchParams(await request.text()).forEach((v, k) => params[k] = v);
    } else new URL(request.url).searchParams.forEach((v, k) => params[k] = v);

    if (!await verifySign(params, CONFIG.MERCHANT_KEY)) return new Response('fail', { status: 400 });

    if (params.trade_status === 'TRADE_SUCCESS') {
        const orderId = params.out_trade_no;
        const tradeNo = params.trade_no;
        const order = await env.DB.prepare('SELECT * FROM orders WHERE order_id = ?').bind(orderId).first();

        if (order && (order.status === 'pending' || order.status === 'cancelled')) {
            let card = await getReservedCardForOrder(env, orderId);
            if (!card) {
                card = await getAvailableCard(env, order.product_id);
            }

            if (card) {
                await env.DB.batch([
                    env.DB.prepare(`
                        UPDATE cards
                        SET is_used = 1, used_at = datetime('now'), reserved_order_id = NULL, reserved_at = NULL
                        WHERE id = ?
                    `).bind(card.id),
                    env.DB.prepare(`
                        UPDATE orders
                        SET status = 'delivered',
                            paid_at = datetime('now'),
                            delivered_at = datetime('now'),
                            trade_no = ?,
                            card_key = ?
                        WHERE order_id = ?
                    `).bind(tradeNo, card.card_key, orderId)
                ]);
            } else {
                await env.DB.prepare(`
                    UPDATE orders
                    SET status = 'paid',
                        paid_at = datetime('now'),
                        trade_no = ?
                    WHERE order_id = ?
                `).bind(tradeNo, orderId).run();
            }
        }
    }
    return new Response('success');
}

async function handleAuthLogin(request) {
    const state = Math.random().toString(36).substring(7);
    const url = `${CONFIG.OAUTH.AUTH_URL}?response_type=code&client_id=${CONFIG.OAUTH.CLIENT_ID}&state=${state}&redirect_uri=${encodeURIComponent(CONFIG.OAUTH.REDIRECT_URI)}`;
    return Response.redirect(url, 302);
}

async function handleAuthCallback(request, env) {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    if (!code) return new Response('Missing code', { status: 400 });

    // Exchange Code for Token
    const tokenResp = await fetch(CONFIG.OAUTH.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CONFIG.OAUTH.CLIENT_ID,
            client_secret: CONFIG.OAUTH.CLIENT_SECRET,
            code: code,
            redirect_uri: CONFIG.OAUTH.REDIRECT_URI
        })
    });

    if (!tokenResp.ok) return new Response('Failed to get token: ' + await tokenResp.text(), { status: 400 });
    const tokenData = await tokenResp.json();

    // Get User Info
    const userResp = await fetch(CONFIG.OAUTH.USER_URL, {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    });

    if (!userResp.ok) return new Response('Failed to get user info', { status: 400 });
    const userInfo = await userResp.json();

    // Create Session
    const sessionId = crypto.randomUUID();
    const csrfToken = crypto.randomUUID(); // Generate CSRF Token
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    await env.DB.prepare('INSERT INTO sessions (id, user_id, username, avatar_url, trust_level, expires_at, csrf_token) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(sessionId, userInfo.id, userInfo.username, userInfo.avatar_url, userInfo.trust_level, expiresAt, csrfToken).run();

    await recordLoginUser(env.DB, userInfo.id, userInfo.username);

    return new Response('', {
        status: 302,
        headers: {
            'Location': '/',
            'Set-Cookie': `${CONFIG.COOKIE_SESSION}=${sessionId}; Path=/; Secure; SameSite=Lax; HttpOnly`
        }
    });
}

async function handleAuthLogout(request, env) {
    const cookie = request.headers.get('Cookie');
    if (cookie) {
        const match = cookie.match(new RegExp(`${CONFIG.COOKIE_SESSION}=([^;]+)`));
        if (match) {
            await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(match[1]).run();
        }
    }
    return new Response('', {
        status: 302,
        headers: {
            'Location': '/',
            'Set-Cookie': `${CONFIG.COOKIE_SESSION}=; Path=/; Max-Age=0`
        }
    });
}


async function handleAdminRefund(request, env) {
    if (!await isAdmin(request, env)) return new Response('Access Denied', { status: 403 });

    const url = new URL(request.url);
    const orderId = url.pathname.split('/').pop();

    const order = await env.DB.prepare('SELECT * FROM orders WHERE order_id = ?').bind(orderId).first();
    if (!order) return new Response('Order not found', { status: 404 });
    if (order.status !== 'delivered' && order.status !== 'paid') {
        return new Response('Order status not refundable', { status: 400 });
    }
    if (!order.trade_no) {
        return new Response('Missing trade_no (Linux DO Trade ID), cannot refund.', { status: 400 });
    }

    // Call Linux DO Credit Refund API
    const params = {
        pid: CONFIG.MERCHANT_ID,
        key: CONFIG.MERCHANT_KEY,
        trade_no: order.trade_no,
        money: order.amount
    };

    try {
        const resp = await fetch(CONFIG.REFUND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'LDC-Shop-Worker/1.0',
                'Accept': 'application/json'
            },
            body: new URLSearchParams(params)
        });
        const text = await resp.text();
        let result;
        try {
            result = JSON.parse(text);
        } catch (e) {
            return new Response(`Refund API Error (Invalid JSON): ${text.substring(0, 500)}...`, { status: 502 });
        }

        if (result.code === 1) {
            await env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE order_id = ?").bind(orderId).run();
            // Optional: If delivered, we technically should "revoke" the key, but we'll just leave it marked as used/delivered locally mostly.
            // But we already updated status to refunded.
            return Response.redirect(`${url.origin}/admin/orders`, 302);
        } else {
            return new Response(`Refund Failed: ${result.msg || JSON.stringify(result)}`, { status: 400 });
        }
    } catch (e) {
        return new Response(`Refund Error: ${e.message}`, { status: 500 });
    }
}

async function handleReturn(request, env) {
    const url = new URL(request.url);
    const locale = resolveLocale(request);
    let orderId = null;

    if (url.pathname.startsWith('/callback/')) {
        orderId = url.pathname.replace('/callback/', '').split('/')[0];
    }

    if (!orderId) {
        orderId = url.searchParams.get('out_trade_no');
    }

    if (!orderId) {
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/ldc_pending_order=([^;]+)/);
        if (match) orderId = match[1];
    }

    if (orderId && orderId.includes('?')) {
        orderId = orderId.split('?')[0];
    }

    if (orderId) {
        await cancelExpiredOrders(env, { orderId });
    }

    const params = Object.fromEntries(url.searchParams.entries());
    const user = await getSession(request, env);
    const siteSettings = await getSiteSettings(env.DB);
    return new Response(renderCallbackPage({ locale, orderId, params, user, siteSettings }), { headers: HTML_HEADER });
}
