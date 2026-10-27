package app.backup.source

import android.app.Application
import app.backup.core.CloudInit

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        CloudInit.configure(this)
        Prefs.init(this)
    }
}
