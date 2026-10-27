plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
if (file("google-services.json").exists()) apply(plugin = "com.google.gms.google-services")

android {
    namespace = "app.backup.viewer"
    compileSdk = 34
    defaultConfig {
        applicationId = "app.backup.viewer"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }
    buildTypes { release { isMinifyEnabled = false } }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { compose = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation(project(":core"))
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
