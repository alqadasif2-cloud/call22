plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.backup.core"
    compileSdk = 34
    defaultConfig { minSdk = 26 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
}

dependencies {
    api(platform("com.google.firebase:firebase-bom:33.3.0"))
    api("com.google.firebase:firebase-auth")
    api("com.google.firebase:firebase-firestore")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    api("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")
    api(platform("androidx.compose:compose-bom:2024.09.00"))
    api("androidx.compose.material3:material3")
    api("androidx.compose.ui:ui")
    api("androidx.activity:activity-compose:1.9.2")
    api("androidx.lifecycle:lifecycle-runtime-compose:2.8.6")
    api("androidx.core:core-ktx:1.13.1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
