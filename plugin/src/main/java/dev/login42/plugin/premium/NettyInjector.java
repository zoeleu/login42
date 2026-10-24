package dev.login42.plugin.premium;

import io.netty.channel.Channel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelHandler;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInboundHandlerAdapter;
import io.netty.channel.ChannelInitializer;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.function.Supplier;

/**
 * Puts a handler at the very front of every new connection's pipeline without NMS compile-time access:
 * the server's listening channels are found by reflection (Mojang names, which Paper-based servers use at
 * runtime), and a handler on each listening channel adds our initializer to every accepted child channel.
 */
final class NettyInjector {
    private NettyInjector() {}

    @SuppressWarnings("unchecked")
    static List<ChannelFuture> listeningChannels(Object craftServer) throws ReflectiveOperationException {
        Object minecraftServer = craftServer.getClass().getMethod("getServer").invoke(craftServer); // CraftServer#getServer
        Method getConnection = minecraftServer.getClass().getMethod("getConnection"); // MinecraftServer#getConnection
        Object listener = getConnection.invoke(minecraftServer);
        Field channels = field(listener.getClass(), "channels"); // ServerConnectionListener#channels
        channels.setAccessible(true);
        return (List<ChannelFuture>) channels.get(listener);
    }

    private static Field field(Class<?> type, String name) throws NoSuchFieldException {
        for (Class<?> c = type; c != null; c = c.getSuperclass()) {
            try {
                return c.getDeclaredField(name);
            } catch (NoSuchFieldException ignored) {
                // try the superclass
            }
        }
        throw new NoSuchFieldException(name);
    }

    static void install(List<ChannelFuture> channels, Supplier<ChannelHandler> gateFactory) {
        for (ChannelFuture f : List.copyOf(channels)) {
            f.channel().pipeline().addFirst("login42_premium_inject", new ChannelInboundHandlerAdapter() {
                @Override
                public void channelRead(ChannelHandlerContext ctx, Object msg) {
                    if (msg instanceof Channel child) {
                        child.pipeline().addLast(new ChannelInitializer<Channel>() {
                            @Override
                            protected void initChannel(Channel ch) {
                                // First of all handlers, before the server's own (and OfflineEncryptor's).
                                ch.pipeline().addFirst("login42_premium_gate", gateFactory.get());
                            }
                        });
                    }
                    ctx.fireChannelRead(msg);
                }
            });
        }
    }
}
