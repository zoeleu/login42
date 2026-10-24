package dev.login42.plugin;

import static org.junit.jupiter.api.Assertions.*;

import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.junit.jupiter.api.Test;

class ChatStyleTest {
    @Test
    void acceptsOnlyColorsNotMarkupOrDecorations() {
        assertEquals(NamedTextColor.AQUA, ChatStyle.color("AQUA"));
        assertEquals(0x12ABEF, ChatStyle.color("#12ABEF").value());
        for (String bad : new String[] { "bold", "obfuscated", "<red>", "&c", "#123", "#gggggg", "red bold", "" }) {
            assertNull(ChatStyle.color(bad), bad);
        }
        assertNull(ChatStyle.color(null));
    }

    @Test
    void titledNameIsBoldWithLiteralHoverText() {
        String title = "jdoe, Writer's soul <red>";
        Component name = ChatStyle.name("jdoe", NamedTextColor.AQUA, title);
        assertEquals(TextDecoration.State.TRUE, name.decoration(TextDecoration.BOLD));
        assertEquals(Component.text(title), name.hoverEvent().value());
        assertEquals(NamedTextColor.AQUA, name.color());
        assertNull(ChatStyle.name("other", null, null).hoverEvent());
        assertNotEquals(TextDecoration.State.TRUE, ChatStyle.name("other", null, "").decoration(TextDecoration.BOLD));
    }

    @Test
    void boldAndHoverDoNotLeakIntoMessageOrDelimiters() {
        Component line = ChatStyle.render("user", NamedTextColor.GREEN, "Selected title", Component.text("hello <red>"));
        assertEquals(4, line.children().size());
        assertEquals(TextDecoration.State.TRUE, line.children().get(1).decoration(TextDecoration.BOLD));
        Component message = line.children().get(3);
        assertEquals("hello <red>", ((TextComponent) message).content());
        assertNull(message.color());
        assertNull(message.hoverEvent());
        assertNotEquals(TextDecoration.State.TRUE, message.decoration(TextDecoration.BOLD));
        assertEquals(NamedTextColor.GRAY, line.children().get(2).color());
    }

    @Test
    void preservesExistingMessageFormattingInsteadOfApplyingNameColor() {
        Component message = Component.text("hello", NamedTextColor.YELLOW).decorate(TextDecoration.ITALIC);
        Component line = ChatStyle.render("user", NamedTextColor.AQUA, null, message);
        assertEquals(message, line.children().get(3));
        assertEquals(NamedTextColor.AQUA, line.children().get(1).color());
    }
}
