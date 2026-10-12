// Gepetel in the menu bar: long hair, a smiling face, a goatee, as a template
// image — one shape that macOS tints for a light or dark menu bar and inverts
// when the menu is open. The painted portrait shrunk to 18 points is a brown
// smudge, and a solid silhouette came out stern (two attempts); rounded line
// art in the weight of SF Symbols reads as friendly.
//
// The state is a mark on the same face, never a different picture, so the
// person always knows which icon is Gepetel:
//   online      the face
//   connecting  the face, faint
//   busy        the face, with a dot at the shoulder
//   offline     the face, faint, with a hollow ring at the shoulder
import AppKit

enum Glyph {
    enum Mark { case none, dot, ring }

    static func image(faint: Bool = false, mark: Mark = .none, size: CGFloat = 18) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let s = rect.width / 18
            ctx.scaleBy(x: s, y: s)
            ctx.setAlpha(faint ? 0.45 : 1)
            ctx.beginTransparencyLayer(auxiliaryInfo: nil)
            NSColor.black.setFill()
            NSColor.black.setStroke()
            func stroke(_ p: NSBezierPath, _ w: CGFloat = 1.35) {
                p.lineWidth = w
                p.lineCapStyle = .round
                p.lineJoinStyle = .round
                p.stroke()
            }

            // Long hair: one soft arch from shoulder to shoulder, with a tuft
            // where his hair sticks up.
            let hair = NSBezierPath()
            hair.move(to: NSPoint(x: 3.4, y: 4.2))
            hair.curve(to: NSPoint(x: 3.6, y: 12.0), controlPoint1: NSPoint(x: 3.0, y: 6.8), controlPoint2: NSPoint(x: 3.0, y: 9.6))
            hair.curve(to: NSPoint(x: 9.0, y: 16.4), controlPoint1: NSPoint(x: 4.3, y: 14.8), controlPoint2: NSPoint(x: 6.5, y: 16.4))
            hair.curve(to: NSPoint(x: 14.4, y: 12.0), controlPoint1: NSPoint(x: 11.5, y: 16.4), controlPoint2: NSPoint(x: 13.7, y: 14.8))
            hair.curve(to: NSPoint(x: 14.6, y: 4.2), controlPoint1: NSPoint(x: 15.0, y: 9.6), controlPoint2: NSPoint(x: 15.0, y: 6.8))
            stroke(hair)
            let tuft = NSBezierPath()
            tuft.move(to: NSPoint(x: 9.6, y: 16.3))
            tuft.curve(to: NSPoint(x: 10.8, y: 17.6), controlPoint1: NSPoint(x: 10.1, y: 16.9), controlPoint2: NSPoint(x: 10.4, y: 17.4))
            stroke(tuft, 1.1)

            // The face: a rounded oval, with a fringe sweeping across the top.
            let face = NSBezierPath(ovalIn: NSRect(x: 5.6, y: 5.2, width: 6.8, height: 8.6))
            stroke(face, 1.2)
            let fringe = NSBezierPath()
            fringe.move(to: NSPoint(x: 5.9, y: 11.6))
            fringe.curve(to: NSPoint(x: 11.4, y: 13.1), controlPoint1: NSPoint(x: 7.6, y: 12.0), controlPoint2: NSPoint(x: 9.8, y: 12.4))
            stroke(fringe, 1.1)

            // Eyes, and a small smile.
            NSBezierPath(ovalIn: NSRect(x: 7.1, y: 9.1, width: 1.3, height: 1.3)).fill()
            NSBezierPath(ovalIn: NSRect(x: 9.6, y: 9.1, width: 1.3, height: 1.3)).fill()
            let smile = NSBezierPath()
            smile.move(to: NSPoint(x: 7.7, y: 7.5))
            smile.curve(to: NSPoint(x: 10.3, y: 7.5), controlPoint1: NSPoint(x: 8.4, y: 6.7), controlPoint2: NSPoint(x: 9.6, y: 6.7))
            stroke(smile, 1.0)
            // His goatee, under the chin's curve.
            let goatee = NSBezierPath()
            goatee.move(to: NSPoint(x: 8.3, y: 5.6))
            goatee.curve(to: NSPoint(x: 9.7, y: 5.6), controlPoint1: NSPoint(x: 8.8, y: 5.9), controlPoint2: NSPoint(x: 9.2, y: 5.9))
            goatee.curve(to: NSPoint(x: 9.0, y: 3.6), controlPoint1: NSPoint(x: 9.7, y: 4.6), controlPoint2: NSPoint(x: 9.4, y: 3.9))
            goatee.curve(to: NSPoint(x: 8.3, y: 5.6), controlPoint1: NSPoint(x: 8.6, y: 3.9), controlPoint2: NSPoint(x: 8.3, y: 4.6))
            goatee.fill()

            // Shoulders.
            let shoulders = NSBezierPath()
            shoulders.move(to: NSPoint(x: 1.6, y: 0.4))
            shoulders.curve(to: NSPoint(x: 6.0, y: 3.4), controlPoint1: NSPoint(x: 2.2, y: 2.2), controlPoint2: NSPoint(x: 3.8, y: 3.2))
            shoulders.move(to: NSPoint(x: 12.0, y: 3.4))
            shoulders.curve(to: NSPoint(x: 16.4, y: 0.4), controlPoint1: NSPoint(x: 14.2, y: 3.2), controlPoint2: NSPoint(x: 15.8, y: 2.2))
            stroke(shoulders)
            ctx.endTransparencyLayer()

            // The state mark, always at full strength so it reads even on a
            // faint face.
            ctx.setAlpha(1)
            switch mark {
            case .none: break
            case .dot:
                NSBezierPath(ovalIn: NSRect(x: 13, y: 0, width: 5, height: 5)).fill()
            case .ring:
                let r = NSBezierPath(ovalIn: NSRect(x: 13.6, y: 0.6, width: 3.8, height: 3.8))
                r.lineWidth = 1.3
                NSColor.black.setStroke()
                r.stroke()
            }
            return true
        }
        img.isTemplate = true
        return img
    }
}
