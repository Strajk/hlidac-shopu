FROM node:20-bullseye

# Add jq to the image
RUN apt update &&\
    apt install -y jq &&\
    apt clean &&\
    rm -rf /var/lib/apt/lists/*

WORKDIR /workdir
