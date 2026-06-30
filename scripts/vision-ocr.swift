import AppKit
import Foundation
import Vision

struct OcrLine: Encodable {
  let text: String
  let confidence: Float
}

struct OcrPayload: Encodable {
  let text: String
  let textPreview: String
  let engine: String
  let averageConfidence: Float
  let observations: [OcrLine]
  let error: String?
}

func emit(_ payload: OcrPayload) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.withoutEscapingSlashes]
  if let data = try? encoder.encode(payload),
     let json = String(data: data, encoding: .utf8) {
    print(json)
  } else {
    print("{\"text\":\"\",\"textPreview\":\"\",\"engine\":\"apple_vision\",\"averageConfidence\":0,\"observations\":[],\"error\":\"JSON encode failed\"}")
  }
}

guard CommandLine.arguments.count >= 2 else {
  emit(OcrPayload(text: "", textPreview: "", engine: "apple_vision", averageConfidence: 0, observations: [], error: "Missing image path"))
  exit(0)
}

let imagePath = CommandLine.arguments[1]
let imageUrl = URL(fileURLWithPath: imagePath)

guard let image = NSImage(contentsOf: imageUrl),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  emit(OcrPayload(text: "", textPreview: "", engine: "apple_vision", averageConfidence: 0, observations: [], error: "Image decode failed"))
  exit(0)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.minimumTextHeight = 0.01
request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
  try handler.perform([request])
  let recognized = (request.results ?? [])
    .sorted { left, right in
      if abs(left.boundingBox.minY - right.boundingBox.minY) > 0.015 {
        return left.boundingBox.minY > right.boundingBox.minY
      }
      return left.boundingBox.minX < right.boundingBox.minX
    }
    .compactMap { observation -> OcrLine? in
      guard let candidate = observation.topCandidates(1).first else { return nil }
      let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { return nil }
      return OcrLine(text: text, confidence: candidate.confidence)
    }

  let text = recognized.map { $0.text }.joined(separator: "\n")
  let averageConfidence = recognized.isEmpty
    ? 0
    : recognized.reduce(Float(0)) { $0 + $1.confidence } / Float(recognized.count)
  emit(OcrPayload(
    text: text,
    textPreview: String(text.prefix(1200)),
    engine: "apple_vision",
    averageConfidence: averageConfidence,
    observations: recognized,
    error: nil
  ))
} catch {
  emit(OcrPayload(text: "", textPreview: "", engine: "apple_vision", averageConfidence: 0, observations: [], error: error.localizedDescription))
}
