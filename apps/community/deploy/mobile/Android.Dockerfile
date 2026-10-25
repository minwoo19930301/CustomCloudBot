# ARM64 only. BusyBox verifies upstream artifacts before they enter Android.
FROM busybox@sha256:c542a2b3cb3c982440890284aac884e89dbf468d5ff1c206fd2ba8ea23257420 AS keyboard
WORKDIR /keyboard
ADD https://github.com/senzhk/ADBKeyBoard/releases/download/v2.4-dev/keyboardservice-debug.apk ADBKeyboard.apk
ADD https://raw.githubusercontent.com/senzhk/ADBKeyBoard/98dc653e8c5e98b3bf9a69561b723545bc5fd5da/LICENSE LICENSE
ADD https://github.com/senzhk/ADBKeyBoard/archive/98dc653e8c5e98b3bf9a69561b723545bc5fd5da.tar.gz source.tar.gz
RUN echo 'e0d0cf276b710cb34c46121f58720f5285a83ed410b0d45f57a0677b67dc2852  ADBKeyboard.apk' | sha256sum -c - \
 && echo '7ea4b1fa1256b0ab2bbbff489e5e8d8f1f9b864504d60091ff871d80e04f21fa  LICENSE' | sha256sum -c - \
 && echo '5e4987fe01697bb927a58c3b183c9b6664732731733b363bc5e77a23e022fe56  source.tar.gz' | sha256sum -c - \
 && chmod 0644 ADBKeyboard.apk LICENSE source.tar.gz

FROM redroid/redroid@sha256:3c7f9450188226bf8042c0159b9b38abe2106f1ceb0dfa45fae1cbc6409cd9bb
COPY --from=keyboard /keyboard/ADBKeyboard.apk /system/app/ADBKeyboard/ADBKeyboard.apk
COPY --from=keyboard /keyboard/LICENSE /system/etc/adbkeyboard/LICENSE
COPY --from=keyboard /keyboard/source.tar.gz /system/etc/adbkeyboard/source.tar.gz
