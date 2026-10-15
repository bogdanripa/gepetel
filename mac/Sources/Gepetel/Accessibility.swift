// Reading Chrome through Accessibility (OSInput.swift): which window is
// Gepetel's, where its page is on screen, which tab it shows.
import AppKit
import ApplicationServices

extension OSInput {
    // MARK: - Walking the tree

    static func texts(_ e: AXUIElement, depth: Int, budget: inout Int) -> [String] {
        if depth > 12 || budget <= 0 { return [] }
        budget -= 1
        var out: [String] = []
        for a in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute] { if let v = attr(e, a), !v.isEmpty { out.append(v) } }
        for k in children(e) { out += texts(k, depth: depth + 1, budget: &budget) }
        return out
    }

    static func button(in e: AXUIElement, titled names: [String], depth: Int, budget: inout Int) -> AXUIElement? {
        if depth > 12 || budget <= 0 { return nil }
        budget -= 1
        if attr(e, kAXRoleAttribute) == (kAXButtonRole as String) {
            let t = (attr(e, kAXTitleAttribute) ?? attr(e, kAXDescriptionAttribute) ?? "").lowercased().trimmingCharacters(in: .whitespaces)
            if names.contains(t) { return e }
        }
        for k in children(e) { if let b = button(in: k, titled: names, depth: depth + 1, budget: &budget) { return b } }
        return nil
    }

    // MARK: - Chrome's window

    struct Window { let element: AXUIElement; let frame: CGRect }

    /// Gepetel's window among Chrome's: the one whose tab strip shows
    /// Gepetel's tab group ("Playwright · Gepetel"). A maximized window of the
    /// person's has the same size, so size alone decides only when exactly
    /// one window has it. Never a guess between windows: a click in the
    /// person's own window would be a click on their behalf.
    static func chromeWindow(width: Double, height: Double, url: String = "") -> Window? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundle).first else { return nil }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        let framed = windows.compactMap { w in frame(of: w).map { Window(element: w, frame: $0) } }
        // A window showing exactly this page in its address bar: a popup —
        // Google's sign-in from booking.com's — has no tab strip to carry
        // the group's label, but it is the only window on its page.
        // Only a window with no tab strip: the person's own window may show
        // the same page, and the job's clicks come here too (every one of
        // them, since 0.13.5) — a labelled window showing it comes first.
        if !url.isEmpty {
            let showing = framed.filter { w in addressBar(w.element).map { samePage($0, url) } ?? false }
            let mine = showing.filter { shows($0.element, "Gepetel") }
            if mine.count == 1 { return mine[0] }
            let popups = showing.filter { tabs($0.element).isEmpty }
            if popups.count == 1 { return popups[0] }
        }
        let labelled = framed.filter { shows($0.element, "Gepetel") }
        let sized = { (ws: [Window]) in ws.filter { abs($0.frame.width - width) <= 2 && abs($0.frame.height - height) <= 2 } }
        if labelled.count == 1 { return labelled[0] }
        if labelled.count > 1 { return sized(labelled).count == 1 ? sized(labelled)[0] : nil }
        return sized(framed).count == 1 ? sized(framed)[0] : nil
    }

    /// Whether something in this window (its tab strip) is titled with this.
    static func shows(_ e: AXUIElement, _ text: String, depth: Int = 0, budget: inout Int) -> Bool {
        if depth > 12 || budget <= 0 { return false }
        budget -= 1
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute] {
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success, let s = v as? String,
               s.localizedCaseInsensitiveContains(text) { return true }
        }
        var c: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &c) == .success, let kids = c as? [AXUIElement] else { return false }
        for k in kids where shows(k, text, depth: depth + 1, budget: &budget) { return true }
        return false
    }
    static func shows(_ e: AXUIElement, _ text: String) -> Bool { var budget = 3000; return shows(e, text, budget: &budget) }

    static func frame(of w: AXUIElement) -> CGRect? {
        var pos: CFTypeRef?, size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &pos) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &size) == .success else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(pos as! AXValue, .cgPoint, &p)
        AXValueGetValue(size as! AXValue, .cgSize, &s)
        return CGRect(origin: p, size: s)
    }

    /// The page's own rectangle on screen: the largest web area in the window.
    static func webArea(in w: AXUIElement) -> CGRect? {
        var best: CGRect?, budget = 4000
        func walk(_ e: AXUIElement, _ d: Int) {
            if d > 16 || budget <= 0 { return }
            budget -= 1
            if attr(e, kAXRoleAttribute) == "AXWebArea", let f = frame(of: e), f.width > 50, f.height > 50 {
                if best == nil || f.width * f.height > best!.width * best!.height { best = f }
                return   // frames inside it are smaller
            }
            for k in children(e) { walk(k, d + 1) }
        }
        walk(w, 0)
        return best
    }

    // MARK: - The tab

    /// The address bar's text: Chrome shows the visible tab's address there.
    static func addressBar(_ w: AXUIElement) -> String? {
        var budget = 3000
        return findText(w, depth: 0, budget: &budget)
    }
    private static func findText(_ e: AXUIElement, depth: Int, budget: inout Int) -> String? {
        if depth > 14 || budget <= 0 { return nil }
        budget -= 1
        if attr(e, kAXRoleAttribute) == (kAXTextFieldRole as String), let v = attr(e, kAXValueAttribute), v.contains(".") { return v }
        for k in children(e) { if let v = findText(k, depth: depth + 1, budget: &budget) { return v } }
        return nil
    }

    /// The tabs in the window's tab strip (AXRadioButton under the tab group).
    static func tabs(_ w: AXUIElement) -> [AXUIElement] {
        var out: [AXUIElement] = [], budget = 3000
        func walk(_ e: AXUIElement, _ d: Int, inStrip: Bool) {
            if d > 14 || budget <= 0 { return }
            budget -= 1
            let role = attr(e, kAXRoleAttribute) ?? ""
            if inStrip && role == (kAXRadioButtonRole as String) { out.append(e); return }
            for k in children(e) { walk(k, d + 1, inStrip: inStrip || role == (kAXTabGroupRole as String)) }
        }
        walk(w, 0, inStrip: false)
        return out
    }

    /// Same page: host and path, the way the address bar shows them (no
    /// scheme, no "www.", no trailing slash, no query or fragment).
    static func samePage(_ shown: String, _ url: String) -> Bool {
        func norm(_ s: String) -> String {
            var t = s.lowercased()
            for p in ["https://", "http://"] where t.hasPrefix(p) { t.removeFirst(p.count) }
            if t.hasPrefix("www.") { t.removeFirst(4) }
            if let q = t.firstIndex(where: { $0 == "?" || $0 == "#" }) { t = String(t[..<q]) }
            while t.hasSuffix("/") { t.removeLast() }
            return t
        }
        let a = norm(shown), b = norm(url)
        // Exactly: a parent path is another tab's page (the trips list is not
        // a trip).
        return !a.isEmpty && a == b
    }

    static func showTab(in w: AXUIElement, url: String) -> Bool {
        if let shown = addressBar(w), samePage(shown, url) { return true }
        for t in tabs(w).prefix(30) {
            AXUIElementPerformAction(t, kAXPressAction as CFString)
            usleep(250_000)
            if let shown = addressBar(w), samePage(shown, url) { return true }
        }
        return false
    }

    static func attr(_ e: AXUIElement, _ a: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success else { return nil }
        return v as? String
    }
    static func children(_ e: AXUIElement) -> [AXUIElement] {
        var c: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &c) == .success else { return [] }
        return c as? [AXUIElement] ?? []
    }

    static func bringForward(_ w: AXUIElement) {
        NSRunningApplication.runningApplications(withBundleIdentifier: chromeBundle).first?.activate()
        AXUIElementPerformAction(w, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
        usleep(150_000)
    }
}
