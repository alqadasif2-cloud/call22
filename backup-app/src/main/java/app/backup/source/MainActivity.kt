@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.backup.source

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.backup.core.CloudRepo
import app.backup.core.AuthMessages
import app.backup.core.Net
import app.backup.core.RecordType
import app.backup.core.UsernameAuth
import app.backup.core.ui.AuthGate
import app.backup.core.ui.BackupTheme
import app.backup.core.ui.ConfirmDialog
import app.backup.core.ui.InfoRow
import app.backup.core.ui.PasswordDialog
import app.backup.core.ui.SectionTitle
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            BackupTheme {
                AuthGate {
                    val done by Prefs.onboardingDone.collectAsState()
                    if (!done) Onboarding() else Home()
                }
            }
        }
    }
}

private fun fmt(ms: Long) =
    if (ms == 0L) "—" else SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.ENGLISH).format(Date(ms))

private fun typeLabel(t: RecordType) = when (t) {
    RecordType.CALL -> "سجل المكالمات"
    RecordType.SMS -> "الرسائل النصية"
    RecordType.CLIP -> "نصوص الحافظة التي أختار حفظها"
}

// ---------------------------------------------------------------- الإعداد الأول
@Composable
fun Onboarding() {
    var name by remember { mutableStateOf(Prefs.deviceName.value) }
    var calls by remember { mutableStateOf(true) }
    var sms by remember { mutableStateOf(true) }
    var clip by remember { mutableStateOf(true) }

    fun finish(types: Set<String>) = Prefs.completeOnboarding(name.trim().ifBlank { Build.MODEL }, types)

    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
        val en = mutableSetOf<String>()
        if (calls && res[Manifest.permission.READ_CALL_LOG] == true) en += RecordType.CALL.id
        if (sms && res[Manifest.permission.READ_SMS] == true) en += RecordType.SMS.id
        if (clip) en += RecordType.CLIP.id
        finish(en)
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Text("مرحبًا بك", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(12.dp))
        Text(
            "هذا التطبيق يحتفظ بنسخة احتياطية من بياناتك الشخصية على هذا الهاتف (سجل المكالمات، الرسائل النصية، " +
                "ونصوص تختار حفظها من الحافظة) ويرفعها مشفّرة إلى حسابك السحابي الخاص، لتستعيدها إن تعطل الهاتف أو تغيّر.\n\n" +
                "لا يعمل إلا بالأنواع التي تختارها أدناه، وبعد موافقتك على صلاحيات أندرويد الرسمية. " +
                "يمكنك إيقافه أو حذف بياناتك في أي وقت.",
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(name, { name = it }, label = { Text("اسم الجهاز") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        SectionTitle("أنواع البيانات التي أريد الاحتفاظ بها")
        CheckRow("سجل المكالمات (يتطلب صلاحية قراءة السجل)", calls) { calls = it }
        CheckRow("الرسائل النصية (يتطلب صلاحية قراءة الرسائل)", sms) { sms = it }
        CheckRow("الحافظة (بزر حفظ أو مشاركة يدوية فقط، بلا صلاحيات)", clip) { clip = it }
        Spacer(Modifier.height(8.dp))
        Text(
            "لن يغيّر التطبيق تطبيق الرسائل الافتراضي ولن يتجاوز أي قيد من قيود النظام. " +
                "إذا رفض النظام صلاحية ما فستبقى متاحة طريقة الاستيراد اليدوي من داخل التطبيق.",
            style = MaterialTheme.typography.bodySmall,
        )
        Spacer(Modifier.height(16.dp))
        Button(modifier = Modifier.fillMaxWidth(), onClick = {
            val perms = buildList {
                if (calls) add(Manifest.permission.READ_CALL_LOG)
                if (sms) add(Manifest.permission.READ_SMS)
            }
            if (perms.isEmpty()) finish(if (clip) setOf(RecordType.CLIP.id) else emptySet())
            else launcher.launch(perms.toTypedArray())
        }) { Text("متابعة") }
    }
}

@Composable
private fun CheckRow(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, onChange)
        Text(label, style = MaterialTheme.typography.bodyMedium)
    }
}

// ---------------------------------------------------------------- الشاشة الرئيسية
@Composable
fun Home() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val dao = remember { AppDb.get(ctx).dao() }
    val total by remember { dao.total() }.collectAsState(0)
    val pending by remember { dao.pendingCount() }.collectAsState(0)
    val clips by remember { dao.recent("clip", 30) }.collectAsState(emptyList())
    val online by remember { Net.flow(ctx) }.collectAsState(Net.isOnline(ctx))
    val enabled by Prefs.enabled.collectAsState()
    val paused by Prefs.paused.collectAsState()
    val lastSync by Prefs.lastSyncAt.collectAsState()
    val lastScan by Prefs.lastScanAt.collectAsState()
    val name by Prefs.deviceName.collectAsState()
    val notice by Prefs.notice.collectAsState()
    var message by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<String?>(null) }
    var pendingType by remember { mutableStateOf<RecordType?>(null) }

    // تسجيل الجهاز وبدء المهام المستدامة
    LaunchedEffect(enabled) {
        try { CloudRepo().registerDevice(Prefs.deviceId, name, Build.MODEL, enabled.toList()) } catch (_: Exception) {}
        Scheduler.start(ctx)
        Scheduler.syncNow(ctx)
    }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        pendingType?.let {
            if (ok) Prefs.setEnabled(it.id, true) else message = "لم تُمنح الصلاحية، لذا لا يمكن تفعيل هذا النوع."
        }
        pendingType = null
    }
    val callsPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { scope.launch { message = Importer.importUri(ctx, it, calls = true) } }
    }
    val smsPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let { scope.launch { message = Importer.importUri(ctx, it, calls = false) } }
    }

    fun toggle(t: RecordType, on: Boolean) {
        if (!on) { Prefs.setEnabled(t.id, false); return }
        val p = Perms.forType(t)
        if (p == null || Perms.granted(ctx, p)) Prefs.setEnabled(t.id, true)
        else { pendingType = t; permLauncher.launch(p) }
    }

    val status = when {
        paused -> "المزامنة متوقفة مؤقتًا"
        pending > 0 && !online -> "بانتظار الاتصال: $pending سجل لم يُرفع بعد"
        pending > 0 -> "$pending سجل بانتظار الرفع"
        else -> "لا توجد سجلات بانتظار الرفع"
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text("النسخ الاحتياطي لهذا الهاتف", style = MaterialTheme.typography.headlineSmall)
            OutlinedButton(onClick = { Scheduler.stop(ctx); UsernameAuth.signOut(ctx) }) {
                Text("تسجيل الخروج")
            }
        }
        Text(
            "ينسخ هذا التطبيق الأنواع المفعّلة أدناه إلى حسابك السحابي مشفّرةً، ويمكنك مراجعتها وحذفها في أي وقت.",
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 4.dp),
        )
        Spacer(Modifier.height(12.dp))

        OutlinedCard(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                UsernameAuth.savedUsername(ctx)?.let { InfoRow("اسم المستخدم", it) }
                InfoRow("اسم الجهاز", name)
                InfoRow("حالة النسخ", status)
                InfoRow("الاتصال بالإنترنت", if (online) "متصل" else "غير متصل")
                InfoRow("السجلات المحفوظة محليًا", total.toString())
                InfoRow("بانتظار الرفع", pending.toString())
                InfoRow("آخر مزامنة ناجحة", fmt(lastSync))
                InfoRow("آخر فحص للبيانات", fmt(lastScan))
                notice?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
            Button(onClick = { Scheduler.syncNow(ctx); message = "بدأت المزامنة" }, enabled = !paused) { Text("المزامنة الآن") }
            if (paused) OutlinedButton(onClick = { Prefs.setPaused(false); Scheduler.syncNow(ctx) }) { Text("استئناف") }
            else OutlinedButton(onClick = { Prefs.setPaused(true) }) { Text("إيقاف مؤقت") }
        }
        message?.let { Text(it, modifier = Modifier.padding(top = 8.dp), color = MaterialTheme.colorScheme.primary) }

        SectionTitle("أنواع البيانات المفعّلة")
        RecordType.entries.forEach { t ->
            val permOk = Perms.typeAllowed(ctx, t)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(typeLabel(t), style = MaterialTheme.typography.bodyMedium)
                    if (t.id in enabled && !permOk) Text("الصلاحية غير ممنوحة", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Switch(checked = t.id in enabled && permOk, onCheckedChange = { toggle(t, it) })
            }
        }

        SectionTitle("الحافظة")
        Text("لا يراقب التطبيق الحافظة في الخلفية. اضغط الزر لحفظ ما نسخته الآن، أو استخدم «مشاركة ← حفظ في النسخ الاحتياطي».", style = MaterialTheme.typography.bodySmall)
        Button(onClick = {
            val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(ctx)?.toString()
            scope.launch { message = clipMessage(ClipSaver.save(ctx, text)) }
        }, modifier = Modifier.padding(top = 8.dp)) { Text("حفظ محتوى الحافظة") }
        clips.forEach { c ->
            val text = runCatching { JSONObject(c.json).optString("text") }.getOrDefault("")
            Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
                Text(text.take(120), style = MaterialTheme.typography.bodyMedium)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text("${fmt(c.ts)} — ${if (c.syncState == 1) "مرفوع" else "بانتظار الرفع"}", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = {
                        scope.launch {
                            try {
                                if (c.syncState == 1) CloudRepo().deleteRecord(Prefs.deviceId, c.id)
                                dao.delete(c.id)
                            } catch (e: Exception) { message = "تعذّر حذف النسخة السحابية، لذا لم يُحذف السجل." }
                        }
                    }) { Text("حذف") }
                }
                HorizontalDivider()
            }
        }

        SectionTitle("استيراد يدوي (بديل دون صلاحيات)")
        Text("إذا لم تمنح الصلاحيات، يمكنك اختيار ملف صدّرته بنفسك. المكالمات: CSV بأعمدة number,type,date,duration,name. الرسائل: XML من تطبيق SMS Backup & Restore، أو CSV بأعمدة address,body,date,type.", style = MaterialTheme.typography.bodySmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            OutlinedButton(onClick = { callsPicker.launch(arrayOf("*/*")) }) { Text("استيراد مكالمات") }
            OutlinedButton(onClick = { smsPicker.launch(arrayOf("*/*")) }) { Text("استيراد رسائل") }
        }

        SectionTitle("التحكم في البيانات")
        ActionButton("إعادة رفع كل السجلات المحلية") { scope.launch { dao.resetSync(); Scheduler.syncNow(ctx); message = "أُعيدت كل السجلات إلى قائمة الرفع" } }
        ActionButton("حذف النسخة السحابية لهذا الجهاز") { confirm = "cloud" }
        ActionButton("حذف السجلات المحلية من هذا الهاتف") { confirm = "local" }
        ActionButton("إزالة هذا الجهاز من الحساب وتسجيل الخروج") { confirm = "device" }
        ActionButton("تسجيل الخروج") { Scheduler.stop(ctx); UsernameAuth.signOut(ctx) }
        ActionButton("حذف الحساب وكل بياناته") { confirm = "account" }
        Spacer(Modifier.height(24.dp))
    }

    fun run(kind: String, password: String? = null) {
        confirm = null
        scope.launch {
            try {
                val repo = CloudRepo()
                when (kind) {
                    "cloud" -> { repo.deleteRecords(Prefs.deviceId); message = "حُذفت النسخة السحابية لهذا الجهاز فقط. السجلات المحلية باقية على هاتفك ولن تُرفع من جديد إلا إذا اخترت «إعادة رفع»." }
                    "local" -> { dao.deleteAll(); message = "حُذفت السجلات المحلية فقط، والنسخة السحابية باقية." }
                    "device" -> { Scheduler.stop(ctx); repo.deleteDevice(Prefs.deviceId); UsernameAuth.signOut(ctx) }
                    "account" -> { Scheduler.stop(ctx); repo.deleteAccount(password!!); dao.deleteAll(); Prefs.resetAll(); UsernameAuth.signOut(ctx) }
                }
            } catch (e: Exception) { message = AuthMessages.of(e) }
        }
    }

    when (confirm) {
        "cloud" -> ConfirmDialog("حذف النسخة السحابية", "سيُحذف كل ما رُفع من هذا الجهاز من السحابة. لن تُحذف السجلات المحلية على هذا الهاتف، ولا أي ملفات نزّلتها سابقًا إلى الذاكرة.", "حذف", { run("cloud") }, { confirm = null })
        "local" -> ConfirmDialog("حذف السجلات المحلية", "ستُحذف السجلات من قاعدة بيانات التطبيق على هذا الهاتف فقط. النسخة السحابية والملفات التي نزّلتها لن تتأثر.", "حذف", { run("local") }, { confirm = null })
        "device" -> ConfirmDialog("إزالة الجهاز", "ستُحذف بيانات هذا الجهاز من السحابة ويُسجَّل خروجك. السجلات المحلية تبقى على الهاتف.", "إزالة", { run("device") }, { confirm = null })
        "account" -> PasswordDialog("حذف الحساب", "سيُحذف حسابك وكل نسخك الاحتياطية في السحابة نهائيًا. الملفات التي نزّلتها إلى ذاكرة أي جهاز لن تُحذف.", { run("account", it) }, { confirm = null })
    }
}

@Composable
private fun ActionButton(label: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) { Text(label) }
}
