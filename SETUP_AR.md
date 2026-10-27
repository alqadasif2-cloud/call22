# دليل الإعداد والتشغيل

## 1) تفعيل نظام المصادقة (اسم المستخدم + كلمة المرور) في Firebase
يدعم المشروع طريقتين آمنتين للمصادقة باسم المستخدم وكلمة المرور دون طلب البريد الإلكتروني أو رقم الهاتف أو حساب Google:

### الخيار الأول (المباشر والمجاني على خطة Spark):
1. افتح لوحة تحكم مشروعك في Firebase:
   `https://console.firebase.google.com/project/micro-volt-75v9p/authentication/providers`
2. اختر **Email/Password** ثم فعّل الخيار الأول (**Enable**) واضغط **Save**.
3. تتولى التطبيقات (`backup-app` و`viewer-app` وتطبيق الويب) تحويل اسم المستخدم تلقائيًا إلى معرّف داخلي حتمي مشفّر وحفظ اسم المستخدم ومعرّف الحساب (`UID`) في قاعدة بيانات `Firestore` مع منع تكرار أسماء المستخدمين.

### الخيار الثاني (عبر Firebase Custom Authentication وCloud Functions — خطة Blaze):
يحتوي المجلد `firebase/functions/` على وظيفة سحابية متكاملة (`authUsername`) تستخدم:
- تجزئة كلمات المرور على الخادم عبر خوارزمية `scrypt` مع ملح عشوائي (`32-byte salt`) ومقارنة زمنية ثابتة (`timingSafeEqual`).
- منع تكرار أسماء المستخدمين داخل معاملة ذرّية (`Firestore Transaction`).
- حماية التسجيل وتسجيل الدخول من محاولات التخمين المتكررة (`Rate Limiting` في `/authRateLimits`).
- إصدار رمز مصادقة مخصص (`admin.auth().createCustomToken(uid)`).

لنشر الوظيفة السحابية وقواعد الأمان:
```bash
cd firebase/functions && npm install && cd ..
firebase deploy --only firestore:rules,firestore:indexes,functions
```

## 2) استخدام الحساب نفسه في التطبيقين (`backup-app` و`viewer-app`)
1. افتح **`backup-app`** واضغط **«إنشاء حساب جديد»**.
2. أدخل **اسم المستخدم** (مثلًا: `sami123`) و**كلمة المرور** (مثلًا: `MyBackup2026!`) ثم اضغط **«إنشاء حساب»**؛ سيدخل التطبيق مباشرةً ويحفظ جلستك ومفتاح التشفير الطرفي بأمان.
3. بعد رفع النسخة الاحتياطية، افتح **`viewer-app`** (أو تطبيق الويب) وسجّل الدخول باستخدام **اسم المستخدم وكلمة المرور نفسيهما** (`sami123` / `MyBackup2026!`)؛ ستظهر أجهزتك ونسخك الاحتياطية مباشرةً مع إمكانية استعراضها وتنزيلها.
4. يمكنك إغلاق الجلسة في أي وقت عبر زر **«تسجيل الخروج»**.

## 3) البناء التلقائي لملفي APK على GitHub Actions
1. يقرأ مسار `.github/workflows/build.yml` إعدادات المشروع تلقائيًا من `firebase-applet-config.json` ويولّد ملفي `google-services.json` للحزمتين `app.backup.source` و`app.backup.viewer`.
2. يشغّل المسار تلقائيًا:
   - اختبارات الوحدة لوحدات الأندرويد (`:core`, `:backup-app`, `:viewer-app`).
   - اختبارات أمان `scrypt` والحماية من التخمين (`firebase/functions/authCore.test.js`) وقواعد `Firestore` على المحاكي.
   - بناء ملفي **`backup-app-apk`** و**`viewer-app-apk`** ورفعهما في قسم **Artifacts**.
