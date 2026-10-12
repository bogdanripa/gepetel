// Draws the disk image's window background: the website's cream paper, the
// instruction, and an arrow from the app to Applications. Drawn at build time
// (1x and 2x), so the repository holds code rather than a binary image, and
// the layout here is the one place the icon positions in build.sh refer to.
//
//   swift mac/scripts/dmg-background.swift <out-dir>
//
// Window: 660 × 420 points. App icon centred at (180, 220), Applications at
// (480, 220) — keep in step with ICON_* in build.sh.
import AppKit

let W: CGFloat = 660, H: CGFloat = 420
let out = CommandLine.arguments.dropFirst().first ?? "."

func color(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}
let paper = color(0xF1E7D6), ink = color(0x2A2620), terracotta = color(0xCC6B4E)

func draw(scale: CGFloat, to path: String) {
    let px = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(W * scale), pixelsHigh: Int(H * scale),
                              bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                              colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    px.size = NSSize(width: W, height: H)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: px)
    let ctx = NSGraphicsContext.current!.cgContext
    // Finder measures from the top left; so does everything below.
    ctx.translateBy(x: 0, y: H)
    ctx.scaleBy(x: 1, y: -1)

    paper.setFill()
    NSRect(x: 0, y: 0, width: W, height: H).fill()
    // The site's two soft washes: blue top left, terracotta bottom right.
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    for (c, x, y, r) in [(color(0x9BBEC8, 0.28), W * 0.15, H * 0.05, W * 0.45),
                         (color(0xCC6B4E, 0.10), W * 0.92, H * 0.85, W * 0.45)] {
        let g = CGGradient(colorsSpace: space, colors: [c.cgColor, c.withAlphaComponent(0).cgColor] as CFArray,
                           locations: [0, 1])!
        ctx.drawRadialGradient(g, startCenter: CGPoint(x: x, y: y), startRadius: 0,
                               endCenter: CGPoint(x: x, y: y), endRadius: r, options: [])
    }

    func text(_ s: String, size: CGFloat, weight: NSFont.Weight, alpha: CGFloat, y: CGFloat) {
        let base = NSFont.systemFont(ofSize: size, weight: weight)
        let font = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: size) } ?? base
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        let str = NSAttributedString(string: s, attributes: [
            .font: font, .foregroundColor: ink.withAlphaComponent(alpha), .paragraphStyle: para])
        // Text draws upright only in an unflipped space; flip locally.
        ctx.saveGState()
        ctx.translateBy(x: 0, y: y + size)
        ctx.scaleBy(x: 1, y: -1)
        str.draw(in: NSRect(x: 0, y: 0, width: W, height: size * 1.4))
        ctx.restoreGState()
    }
    text("Drag Gepetel into Applications", size: 26, weight: .bold, alpha: 1, y: 44)
    text("Then open it from Applications — it lives in your menu bar.", size: 14, weight: .regular, alpha: 0.65, y: 352)

    // The arrow: a slight upward arc between the two icons, hand-drawn weight.
    let from = CGPoint(x: 262, y: 214), to = CGPoint(x: 394, y: 214)
    let arc = NSBezierPath()
    arc.move(to: from)
    arc.curve(to: to, controlPoint1: CGPoint(x: 300, y: 184), controlPoint2: CGPoint(x: 356, y: 184))
    arc.lineWidth = 6
    arc.lineCapStyle = .round
    terracotta.setStroke()
    arc.stroke()
    let head = NSBezierPath()
    head.move(to: CGPoint(x: to.x - 18, y: to.y - 15))
    head.line(to: to)
    head.line(to: CGPoint(x: to.x - 22, y: to.y + 6))
    head.lineWidth = 6
    head.lineCapStyle = .round
    head.lineJoinStyle = .round
    head.stroke()

    NSGraphicsContext.restoreGraphicsState()
    try! px.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

draw(scale: 1, to: "\(out)/background.png")
draw(scale: 2, to: "\(out)/background@2x.png")
