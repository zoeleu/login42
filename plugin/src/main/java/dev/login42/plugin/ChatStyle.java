package dev.login42.plugin;

import java.util.List;
import java.util.Locale;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;

/** Plain components only: neither title text nor messages are parsed as markup. */
final class ChatStyle {
    static final String COLOR_KEY = "login42-chat-color";

    static TextColor color(String input) {
        if (input == null) return null;
        String name = input.toLowerCase(Locale.ROOT);
        if (name.matches("#[0-9a-f]{6}")) return TextColor.fromHexString(name);
        return NamedTextColor.NAMES.value(name);
    }

    static List<String> choices() {
        var choices = new java.util.ArrayList<>(NamedTextColor.NAMES.keys());
        choices.add("reset");
        return choices.stream().sorted().toList();
    }

    static Component name(String name, TextColor color, String title) {
        Component out = Component.text(name, color == null ? NamedTextColor.WHITE : color);
        if (title != null && !title.isBlank()) {
            out = out.decorate(TextDecoration.BOLD).hoverEvent(Component.text(title));
        }
        return out;
    }

    static Component render(String name, TextColor color, String title, Component message) {
        TextColor actual = color == null ? NamedTextColor.WHITE : color;
        return Component.empty()
                .append(Component.text("<", NamedTextColor.GRAY))
                .append(name(name, actual, title))
                .append(Component.text("> ", NamedTextColor.GRAY))
                .append(message);
    }
}
