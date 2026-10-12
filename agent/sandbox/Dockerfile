# The sandbox the `shell` tool runs in — a Linux image, built once on the Mac
# and run by Apple's `container` as its own lightweight VM.
#
# What goes in is what a command typically needs and nothing that helps it get
# out: no ssh client, no cloud CLIs, no credential helpers. There is nothing in
# here to steal — the image carries no secrets and the only path from the Mac is
# the /workspace mount — but a tool that is not installed is a tool that cannot
# be talked into running.
FROM debian:stable-slim

# One layer, no recommends, no apt lists left behind: the image is built on
# somebody's laptop over their own connection, so size is their download.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq python3 python3-pip python3-venv \
        git ripgrep pandoc unzip bsdextrautils \
        nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# Debian's python3 refuses `pip install` outside a venv (PEP 668). A sandbox is
# exactly the place where that ceremony is noise, so allow it — the blast radius
# is a VM whose only persistent path is the workspace.
ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    LANG=C.UTF-8 \
    # Colour codes in captured output are noise the model pays for.
    TERM=dumb \
    NO_COLOR=1

# The mount point exists in the image, so a container started without the mount
# still has a working directory rather than failing in a confusing way.
RUN mkdir -p /workspace
WORKDIR /workspace

# `sleep infinity` is the container's whole job: it stays up so `container exec`
# has somewhere to land, and so an installed package survives between commands.
CMD ["sleep", "infinity"]
