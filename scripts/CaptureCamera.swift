import AVFoundation
import AppKit
import Foundation

// CLI: CaptureCamera <output-path.jpg>
// Takes a photo from the default camera and saves as JPEG

class CameraCapture: NSObject, AVCapturePhotoCaptureDelegate {
    let session = AVCaptureSession()
    let output = AVCapturePhotoOutput()
    let outputPath: String
    var done = false

    init(outputPath: String) {
        self.outputPath = outputPath
        super.init()
    }

    func run() -> Bool {
        // Check authorization
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .denied || status == .restricted {
            fputs("ERROR: Camera access denied. Grant permission in System Settings > Privacy > Camera for CaptureCamera.\n", stderr)
            return false
        }

        if status == .notDetermined {
            let sem = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .video) { _ in sem.signal() }
            sem.wait()
            let newStatus = AVCaptureDevice.authorizationStatus(for: .video)
            if newStatus != .authorized {
                fputs("ERROR: Camera access not granted.\n", stderr)
                return false
            }
        }

        guard let device = AVCaptureDevice.default(for: .video) else {
            fputs("ERROR: No camera found.\n", stderr)
            return false
        }

        guard let input = try? AVCaptureDeviceInput(device: device) else {
            fputs("ERROR: Cannot create camera input.\n", stderr)
            return false
        }

        session.beginConfiguration()
        session.sessionPreset = .photo
        if session.canAddInput(input) { session.addInput(input) }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()

        session.startRunning()

        // Wait for camera to warm up
        Thread.sleep(forTimeInterval: 1.0)

        // Capture
        let settings = AVCapturePhotoSettings()
        output.capturePhoto(with: settings, delegate: self)

        // Wait for result (max 10 seconds)
        let deadline = Date().addingTimeInterval(10)
        while !done && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        }

        session.stopRunning()
        return FileManager.default.fileExists(atPath: outputPath)
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        defer { done = true }

        if let error = error {
            fputs("ERROR: \(error.localizedDescription)\n", stderr)
            return
        }

        guard let data = photo.fileDataRepresentation() else {
            fputs("ERROR: Could not get photo data.\n", stderr)
            return
        }

        // Convert to JPEG
        guard let image = NSImage(data: data),
              let tiffData = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffData),
              let jpegData = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
            fputs("ERROR: Could not convert to JPEG.\n", stderr)
            return
        }

        do {
            try jpegData.write(to: URL(fileURLWithPath: outputPath))
            print("OK: Photo saved to \(outputPath)")
        } catch {
            fputs("ERROR: Could not write file: \(error.localizedDescription)\n", stderr)
        }
    }
}

// Main
let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("Usage: CaptureCamera <output-path.jpg>\n", stderr)
    exit(1)
}

let capture = CameraCapture(outputPath: args[1])
exit(capture.run() ? 0 : 1)
