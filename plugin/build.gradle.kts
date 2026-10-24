plugins {
    java
}

repositories {
    maven(url = "https://repo.papermc.io/repository/maven-public/") {
        name = "papermc"
    }
    mavenCentral()
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:26.3.build.214-stable")
    compileOnly("net.luckperms:api:5.4")
    testImplementation("io.papermc.paper:paper-api:26.3.build.214-stable")
    testImplementation("net.luckperms:api:5.4")
    // The server bundles Netty 4.2.16; we only compile against it.
    compileOnly("io.netty:netty-transport:4.2.16.Final")
    compileOnly("io.netty:netty-buffer:4.2.16.Final")
    compileOnly("io.netty:netty-common:4.2.16.Final")
    testImplementation("com.google.code.gson:gson:2.11.0")
    testImplementation("io.netty:netty-transport:4.2.16.Final")
    testImplementation("io.netty:netty-buffer:4.2.16.Final")
    testImplementation("io.netty:netty-common:4.2.16.Final")
}

java {
    toolchain.languageVersion.set(JavaLanguageVersion.of(25))
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}
