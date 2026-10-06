package dev.panestra.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.ViewCompat

class MainActivity : TauriActivity() {
    private var keyboardWasVisible = false
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Keep IME/cutout insets available to Tauri while restoring immersive mode
        // after a keyboard is dismissed without an Activity focus change.
        ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
            val keyboardVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
            if (keyboardWasVisible && !keyboardVisible) window.decorView.post { enterFullscreen() }
            keyboardWasVisible = keyboardVisible
            insets
        }
        enterFullscreen()
    }

    private fun enterFullscreen() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
    }

    override fun onResume() {
        super.onResume()
        window.decorView.post { enterFullscreen() }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) window.decorView.post { enterFullscreen() }
    }
}
