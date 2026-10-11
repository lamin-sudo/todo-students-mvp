# مهامي — تطبيق المهام للطلاب (MVP)

تطبيق مهام **offline-first** للطلاب: عربي RTL، Dark mode، بلا حساب وبلا سيرفر.
كل الداتا كتبقى فـ المتصفح (Dexie/IndexedDB) وكتخدم كاملة بلا أنترنيت.

## التشغيل السريع

```bash
npm install          # تثبيت الحزم
npm run dev          # سيرفر التطوير → http://localhost:5173
npm run build        # typecheck + بناء الإنتاج → dist/
npm run preview      # تشغيل نسخة الإنتاج محلياً → http://localhost:4173
```

أوامر زايدة:

```bash
npm run test         # vitest run (27 اختبار)
npm run typecheck    # tsc --noEmit
```

> **ملاحظة PWA:** الـ Service Worker (`dist/sw.js`) و`manifest.webmanifest` كيتولّدو **غير فـ `npm run build`** (ماشي فـ dev).
> باش تجرّب التثبيت/offline، خاصك `npm run build && npm run preview`، ماشي `npm run dev`.

## هيكل الملفات

```
src/
├── main.tsx              # نقطة الدخول (bootstrapStorage قبل أول paint)
├── App.tsx               # التبويبات + الراوتر + RTL
├── sw.ts                 # Service Worker (precache + periodicsync)
├── index.css             # Tailwind + RTL/dark + كلاسات btn/card
├── lib/
│   ├── db.ts             # Dexie schema: tasks / backups / meta
│   ├── schemas.ts        # Zod (strict) + تقرير الاستيراد
│   ├── backup.ts         # نسخ أسبوعي on-open + prune + restore
│   ├── bootstrap.ts      # persist() + auto-backup + estimate()
│   ├── notifications.ts  # Notification API + feature-detect
│   ├── settings.ts       # الثيم والإعدادات (meta store)
│   └── stats.ts          # streak + إنجاز الأسبوع
├── stores/tasks.ts       # Zustand store
├── hooks/useSettings.ts
└── components/           # TaskList · TaskForm · Stats · Settings
tests/                    # vitest + fake-indexeddb
```

## النسخ الاحتياطي

- **تلقائي:** فكل تشغيل، إلا دازت أكثر من 7 أيام على آخر نسخة → snapshot فـ `backups` store.
- **prune مزدوج:** كيتبقى آخر **8** نسخ، وأي نسخة كتزيد على **2MB تراكمي** كتحيد (الأقدم أولاً) فنفس الـ transaction.
- **استرجاع (`restoreFromBackup`)** كياخد snapshot `pre-restore` قبل أي تعويض، والدمج LWW على `updatedAt` بلا overwrite أعمى.
- **تصدير/استيراد JSON** من الإعدادات (الملف هو الحماية الوحيدة ضد eviction).

## النشر على Vercel

```bash
npm i -g vercel
vercel link          # اربط المشروع
vercel --prod        # نشر
```

`vercel.json` كيضبط SPA rewrite + cache headers (immutable للأصول، `no-store` لـ `sw.js`).

## المراحل

| # | المرحلة | الحالة |
|---|---|---|
| 0 | Scaffold (Vite+React+TS+Tailwind+RTL/Dark+PWA) | ✅ |
| 1 | طبقة الداتا (Dexie + Zod + backup) | ✅ |
| 2 | الشاشات (نماذج/قوائم/فلترة) | ✅ أساسي |
| 3 | تنبيهات + badge | ⏳ |
| 4 | Settings/Stats كاملين + Snackbar التثبيت | ⏳ |
| 5 | QA + Lighthouse PWA ≥ 90 + نشر | ⏳ |
