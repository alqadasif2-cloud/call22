package app.backup.core.ui

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.backup.core.AuthMessages
import app.backup.core.CloudRepo
import app.backup.core.KeyVault
import app.backup.core.Session
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.OAuthProvider
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** بوابة: تسجيل الدخول ← عبارة مرور التشفير ← المحتوى. */
@Composable
fun AuthGate(content: @Composable () -> Unit) {
    val ctx = LocalContext.current
    val auth = remember { FirebaseAuth.getInstance() }
    val vault = remember { KeyVault(ctx.applicationContext) }
    var user by remember { mutableStateOf(auth.currentUser) }
    var unlocked by remember { mutableStateOf(Session.key != null) }
    var checking by remember { mutableStateOf(true) }

    DisposableEffect(Unit) {
        val l = FirebaseAuth.AuthStateListener { a ->
            user = a.currentUser
            if (a.currentUser == null) {
                Session.key = null
                vault.clear()
                unlocked = false
            }
        }
        auth.addAuthStateListener(l)
        onDispose { auth.removeAuthStateListener(l) }
    }
    LaunchedEffect(user?.uid) {
        if (user != null && Session.key == null) {
            vault.load()?.let { Session.key = it; unlocked = true }
        }
        checking = false
    }

    when {
        user == null -> LoginScreen(auth)
        checking -> Loading()
        !unlocked -> PassphraseScreen(vault) { unlocked = true }
        else -> content()
    }
}

@Composable
private fun LoginScreen(auth: FirebaseAuth) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var pairToken by remember { mutableStateOf("") }
    var showEmailForm by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf("") }
    var pw by remember { mutableStateOf("") }
    var register by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun signInWithPairToken(rawToken: String) {
        val tok = rawToken.trim()
        if (tok.isEmpty()) {
            error = "انسخ رمز الربط أولًا من تبويب «الأمان والحساب» في تطبيق الويب."
            return
        }
        scope.launch {
            busy = true; error = null
            try {
                auth.signInWithCredential(GoogleAuthProvider.getCredential(tok, null)).await()
            } catch (e: Exception) {
                error = AuthMessages.of(e)
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("تسجيل الدخول والربط السحابي", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(8.dp))
        Text(
            "اربط هذا الهاتف مباشرةً بنفس حسابك وخزنتك المشفّرة في تطبيق الويب بضغطة واحدة دون أي إعدادات يدوية.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(16.dp))

        OutlinedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("الربط الفوري مع تطبيق الويب (موصى به)", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(6.dp))
                Text(
                    "من تبويب «الأمان والحساب» في تطبيق الويب اضغط «إصدار رمز ربط تطبيق الهاتف»، ثم اضغط الزر أدناه للدخول فورًا.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Spacer(Modifier.height(12.dp))
                Button(
                    enabled = !busy,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = {
                        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        val clip = cm?.primaryClip?.takeIf { it.itemCount > 0 }
                            ?.getItemAt(0)?.coerceToText(ctx)?.toString()?.trim().orEmpty()
                        if (clip.isNotEmpty()) pairToken = clip
                        signInWithPairToken(pairToken)
                    },
                ) { Text("لصق رمز الربط من الحافظة والدخول") }

                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    pairToken,
                    { pairToken = it },
                    label = { Text("أو الصق رمز الربط يدويًا هنا") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (pairToken.isNotBlank()) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        enabled = !busy,
                        modifier = Modifier.fillMaxWidth(),
                        onClick = { signInWithPairToken(pairToken) },
                    ) { Text("دخول بالرمز الملصوق") }
                }
            }
        }

        Spacer(Modifier.height(12.dp))
        OutlinedButton(
            enabled = !busy,
            modifier = Modifier.fillMaxWidth(),
            onClick = {
                val act = ctx.findActivity()
                if (act == null) {
                    error = "تعذّر فتح نافذة المصادقة."
                    return@OutlinedButton
                }
                scope.launch {
                    busy = true; error = null
                    try {
                        val provider = OAuthProvider.newBuilder("google.com").build()
                        auth.startActivityForSignInWithProvider(act, provider).await()
                    } catch (e: Exception) {
                        error = AuthMessages.of(e)
                    } finally {
                        busy = false
                    }
                }
            },
        ) { Text("الدخول عبر متصفح Google") }

        error?.let {
            Spacer(Modifier.height(8.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }

        Spacer(Modifier.height(12.dp))
        HorizontalDivider()
        TextButton(onClick = { showEmailForm = !showEmailForm; error = null }) {
            Text(if (showEmailForm) "إخفاء الدخول بالبريد وكلمة المرور" else "الدخول بالبريد الإلكتروني وكلمة المرور")
        }

        if (showEmailForm) {
            OutlinedTextField(
                email, { email = it }, label = { Text("البريد الإلكتروني") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                pw, { pw = it }, label = { Text("كلمة المرور (8 أحرف على الأقل)") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            Button(
                enabled = !busy && email.isNotBlank() && pw.length >= 8,
                modifier = Modifier.fillMaxWidth(),
                onClick = {
                    scope.launch {
                        busy = true; error = null
                        try {
                            if (register) auth.createUserWithEmailAndPassword(email.trim(), pw).await()
                            else auth.signInWithEmailAndPassword(email.trim(), pw).await()
                        } catch (e: Exception) {
                            error = AuthMessages.of(e)
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(if (register) "إنشاء الحساب" else "دخول") }
            TextButton(onClick = { register = !register; error = null }) {
                Text(if (register) "لدي حساب — تسجيل الدخول" else "ليس لدي حساب — إنشاء حساب")
            }
        }
    }
}

@Composable
private fun PassphraseScreen(vault: KeyVault, onDone: () -> Unit) {
    val scope = rememberCoroutineScope()
    var create by remember { mutableStateOf<Boolean?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var pass by remember { mutableStateOf("") }
    var pass2 by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    LaunchedEffect(attempt) {
        error = null
        create = try {
            !CloudRepo().hasCrypto()
        } catch (e: Exception) {
            error = "تعذّر الاتصال بالخادم. تحقق من الإنترنت ثم أعد المحاولة."
            null
        }
    }

    val isCreate = create
    if (isCreate == null) {
        if (error == null) { Loading(); return }
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
            Text(error!!, color = MaterialTheme.colorScheme.error)
            Button(onClick = { attempt++ }, modifier = Modifier.padding(top = 12.dp)) { Text("إعادة المحاولة") }
        }
        return
    }

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            if (isCreate) "إنشاء عبارة مرور التشفير" else "إدخال عبارة مرور التشفير",
            style = MaterialTheme.typography.headlineSmall,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            if (isCreate)
                "تُشفَّر بياناتك على الجهاز قبل رفعها، ولا يستطيع أحد (ولا الخادم) قراءتها دون هذه العبارة. " +
                    "أدخل العبارة نفسها على كل جهاز معتمد لاستعادة المفتاح. إذا فقدتها فلا يمكن فك تشفير نسخك. (10 أحرف على الأقل)"
            else "أدخل عبارة المرور التي أنشأتها عند أول إعداد لفك تشفير بياناتك على هذا الجهاز.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            pass, { pass = it }, label = { Text("عبارة المرور") }, singleLine = true,
            visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
        )
        if (isCreate) {
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                pass2, { pass2 = it }, label = { Text("تأكيد العبارة") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(),
            )
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Spacer(Modifier.height(16.dp))
        Button(
            modifier = Modifier.fillMaxWidth(),
            enabled = !busy && if (isCreate) pass.length >= 10 && pass == pass2 else pass.isNotEmpty(),
            onClick = {
                scope.launch {
                    busy = true; error = null
                    try {
                        val repo = CloudRepo()
                        val key = if (isCreate) repo.createCrypto(pass.toCharArray()) else repo.unlock(pass.toCharArray())
                        if (key == null) error = "عبارة المرور غير صحيحة"
                        else { vault.save(key); Session.key = key; onDone() }
                    } catch (e: Exception) {
                        error = AuthMessages.of(e)
                    } finally {
                        busy = false
                    }
                }
            },
        ) { Text(if (isCreate) "إنشاء ومتابعة" else "فتح") }
    }
}
