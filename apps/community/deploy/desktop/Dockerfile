FROM debian:bookworm-slim

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    DESKTOP_VNC_PORT=5900 \
    DESKTOP_WEBSOCKET_PORT=6080 \
    DESKTOP_CDP_PORT=9222 \
    DESKTOP_START_URL=about:blank

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
       ca-certificates curl dpkg dbus-x11 fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
       novnc openbox socat tini websockify x11-utils x11vnc xvfb xterm pcmanfm python3-aiohttp \
       python3-pyatspi at-spi2-core dbus \
       pulseaudio pulseaudio-utils libasound2-plugins alsa-utils ffmpeg v4l-utils pavucontrol guvcview \
    && case "${TARGETARCH:-$(dpkg --print-architecture)}" in amd64) chrome_arch=amd64 ;; arm64) chrome_arch=arm64 ;; *) echo "Unsupported Chrome architecture" >&2; exit 1 ;; esac \
    && curl --fail --location --proto '=https' --tlsv1.2 --max-redirs 0 -o /tmp/google-chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_${chrome_arch}.deb" \
    && test "$(dpkg-deb -f /tmp/google-chrome.deb Architecture)" = "${chrome_arch}" \
    && test "$(dpkg-deb -f /tmp/google-chrome.deb Package)" = "google-chrome-stable" \
    && test -n "$(dpkg-deb -f /tmp/google-chrome.deb Version)" \
    && sha256sum /tmp/google-chrome.deb \
    && apt-get install --no-install-recommends -y /tmp/google-chrome.deb \
    && test -x /usr/bin/google-chrome \
    && google-chrome --version \
    && rm -f /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /bin/bash desktop \
    && mkdir -p /home/desktop/.config/openbox /run/desktop \
    && chown -R desktop:desktop /home/desktop /run/desktop

COPY --chmod=0755 entrypoint.sh /usr/local/bin/desktop-entrypoint
COPY --chmod=0755 workspace-bridge.py /usr/local/bin/workspace-bridge
COPY --chmod=0755 media-runtime.py /usr/local/bin/desktop-media
COPY --chmod=0755 media-bridge.py /usr/local/bin/desktop-media-bridge
COPY terminal.desktop chrome.desktop files.desktop camera.desktop sound.desktop /usr/local/share/applications/
COPY browser-openbox.xml /etc/openclawbot/browser-openbox.xml

USER desktop
WORKDIR /home/desktop
EXPOSE 6080 6081 6082 6083 6084 9222
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/desktop-entrypoint"]
