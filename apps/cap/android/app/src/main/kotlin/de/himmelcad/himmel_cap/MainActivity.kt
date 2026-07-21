package de.himmelcad.himmel_cap

import android.Manifest
import android.content.pm.PackageManager
import android.location.GnssMeasurement
import android.location.GnssMeasurementsEvent
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel

/**
 * GNSS platform channel: capabilities, full tracking, raw measurement events.
 * Full integer RTK stays in Dart/native engine boundary (license-clean).
 */
class MainActivity : FlutterActivity() {
    private val methodChannel = "de.himmelcad.cap/gnss"
    private val eventChannel = "de.himmelcad.cap/gnss_events"
    private var eventSink: EventChannel.EventSink? = null
    private var measurementsCallback: GnssMeasurementsEvent.Callback? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, methodChannel)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "getCapabilities" -> {
                        result.success(
                            mapOf(
                                "rawMeasurements" to true,
                                "dualFrequency" to probeDualFrequency(),
                                "fullTracking" to (Build.VERSION.SDK_INT >= 31),
                            ),
                        )
                    }
                    "start" -> {
                        val full = call.argument<Boolean>("fullTracking") ?: true
                        startGnss(full)
                        result.success(null)
                    }
                    "stop" -> {
                        stopGnss()
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, eventChannel)
            .setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                        eventSink = events
                    }

                    override fun onCancel(arguments: Any?) {
                        eventSink = null
                    }
                },
            )
    }

    private fun probeDualFrequency(): Boolean {
        // Runtime truth comes from measurements; default optimistic for modern flagships.
        return Build.VERSION.SDK_INT >= 26
    }

    private fun startGnss(fullTracking: Boolean) {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                ),
                1001,
            )
            return
        }
        val lm = getSystemService(LOCATION_SERVICE) as LocationManager
        stopGnss()
        val cb =
            object : GnssMeasurementsEvent.Callback() {
                override fun onGnssMeasurementsReceived(eventArgs: GnssMeasurementsEvent) {
                    var dual = false
                    var count = 0
                    for (m in eventArgs.measurements) {
                        count++
                        val hz = m.carrierFrequencyHz
                        // L5 ~1176.45e6
                        if (hz > 1.1e9f && hz < 1.3e9f) dual = true
                    }
                    mainHandler.post {
                        eventSink?.success(
                            mapOf(
                                "measurementCount" to count,
                                "dualFrequency" to dual,
                                "clockTimeNanos" to eventArgs.clock.timeNanos,
                            ),
                        )
                    }
                }
            }
        measurementsCallback = cb
        if (Build.VERSION.SDK_INT >= 31 && fullTracking) {
            val req =
                android.location.GnssMeasurementRequest.Builder()
                    .setFullTracking(true)
                    .build()
            lm.registerGnssMeasurementsCallback(mainExecutor, req, cb)
        } else {
            lm.registerGnssMeasurementsCallback(cb, mainHandler)
        }
    }

    private fun stopGnss() {
        val lm = getSystemService(LOCATION_SERVICE) as? LocationManager ?: return
        measurementsCallback?.let { lm.unregisterGnssMeasurementsCallback(it) }
        measurementsCallback = null
    }

    override fun onDestroy() {
        stopGnss()
        super.onDestroy()
    }
}
