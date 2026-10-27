package app.backup.source

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.UUID

object Prefs {
    private lateinit var sp: SharedPreferences

    val enabled = MutableStateFlow<Set<String>>(emptySet())
    val paused = MutableStateFlow(false)
    val lastSyncAt = MutableStateFlow(0L)
    val lastScanAt = MutableStateFlow(0L)
    val onboardingDone = MutableStateFlow(false)
    val deviceName = MutableStateFlow("")
    val notice = MutableStateFlow<String?>(null)

    val deviceId: String get() = sp.getString("deviceId", "")!!

    fun init(ctx: Context) {
        sp = ctx.applicationContext.getSharedPreferences("backup", Context.MODE_PRIVATE)
        load()
    }

    private fun load() {
        if (!sp.contains("deviceId")) sp.edit().putString("deviceId", UUID.randomUUID().toString()).apply()
        enabled.value = sp.getStringSet("enabled", emptySet())!!.toSet()
        paused.value = sp.getBoolean("paused", false)
        lastSyncAt.value = sp.getLong("lastSync", 0L)
        lastScanAt.value = sp.getLong("lastScan", 0L)
        onboardingDone.value = sp.getBoolean("onboarded", false)
        deviceName.value = sp.getString("deviceName", null) ?: "${Build.MANUFACTURER} ${Build.MODEL}"
    }

    fun setEnabled(typeId: String, on: Boolean) {
        val s = enabled.value.toMutableSet().apply { if (on) add(typeId) else remove(typeId) }
        sp.edit().putStringSet("enabled", s).apply()
        enabled.value = s
    }

    fun setPaused(v: Boolean) { sp.edit().putBoolean("paused", v).apply(); paused.value = v }
    fun setLastSync(v: Long) { sp.edit().putLong("lastSync", v).apply(); lastSyncAt.value = v }
    fun setLastScan(v: Long) { sp.edit().putLong("lastScan", v).apply(); lastScanAt.value = v }

    fun cursor(type: String): Long = sp.getLong("cur_$type", 0L)
    fun setCursor(type: String, v: Long) { sp.edit().putLong("cur_$type", v).apply() }

    fun completeOnboarding(name: String, types: Set<String>) {
        sp.edit().putString("deviceName", name).putStringSet("enabled", types).putBoolean("onboarded", true).apply()
        deviceName.value = name; enabled.value = types; onboardingDone.value = true
    }

    /** بعد حذف الحساب: تهيئة كاملة بمعرّف جهاز جديد. */
    fun resetAll() { sp.edit().clear().apply(); load() }
}
