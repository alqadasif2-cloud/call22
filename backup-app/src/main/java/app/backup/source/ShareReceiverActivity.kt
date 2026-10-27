package app.backup.source

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** استقبال نص عبر «مشاركة» — إجراء صريح من المستخدم. */
class ShareReceiverActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val text = intent?.takeIf { it.action == Intent.ACTION_SEND }?.getStringExtra(Intent.EXTRA_TEXT)
        lifecycleScope.launch {
            val msg = clipMessage(ClipSaver.save(applicationContext, text))
            Toast.makeText(applicationContext, msg, Toast.LENGTH_LONG).show()
            finish()
        }
    }
}

fun clipMessage(r: ClipResult) = when (r) {
    ClipResult.SAVED -> "تم الحفظ محليًا وسيُرفع عند توفر الاتصال"
    ClipResult.DUPLICATE -> "هذا النص محفوظ مسبقًا"
    ClipResult.SENSITIVE -> "لم يُحفظ: النص يبدو كلمة مرور أو رمز تحقق أو رقم بطاقة"
    ClipResult.EMPTY -> "لا يوجد نص لحفظه"
    ClipResult.TOO_LONG -> "النص أطول من الحد المسموح (100 ألف حرف)"
    ClipResult.DISABLED -> "نوع «الحافظة» غير مفعّل في التطبيق"
}
