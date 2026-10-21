// Renders an SVG to a PNG at an exact pixel size, with AppKit's SVG support. Square unless a height is given.
// Usage: swift render-svg.swift <in.svg> <out.png> <pixels> [<height>]
import AppKit

let args = CommandLine.arguments
guard args.count == 4 || args.count == 5, let pixels = Int(args[3]), pixels > 0, let height = Int(args.count == 5 ? args[4] : args[3]), height > 0 else {
	FileHandle.standardError.write("usage: render-svg.swift <in.svg> <out.png> <pixels> [<height>]\n".data(using: .utf8)!)
	exit(2)
}
guard let image = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
	FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
	exit(1)
}
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
	exit(1)
}
rep.size = NSSize(width: pixels, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSGraphicsContext.current?.imageInterpolation = .high
image.draw(in: NSRect(x: 0, y: 0, width: pixels, height: height), from: .zero, operation: .copy, fraction: 1)
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: args[2]))
