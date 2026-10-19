FROM python:3.12-slim-bookworm AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
FROM base AS api
COPY backend/ .
CMD ["uvicorn", "autotom.main:app", "--host", "0.0.0.0", "--port", "8000"]

FROM eclipse-temurin:21-jdk-jammy AS groimp
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 https://download.grogra.de/2_2/GroIMP-2.2-all.deb -o /tmp/groimp.deb \
    && echo 'cfba605aee5f19af9d7bff18e9edf0844e8d33ff46cd49398eb08b7e4b65c67d  /tmp/groimp.deb' | sha256sum -c - \
    && dpkg-deb -x /tmp/groimp.deb /tmp/groimp \
    && mv /tmp/groimp/usr/share/GroIMP /opt/groimp \
    && rm -rf /tmp/groimp /tmp/groimp.deb
COPY deploy/PatchFlux.java /opt/groimp/patches/PatchFlux.java
RUN curl -fL --retry 3 https://gitlab.com/grogra/groimp-plugins/GPUFlux/-/raw/795265245c8427047697f74672aba19ff137aa1c/src/main/java/de/grogra/gpuflux/jocl/JOCLCPP.java -o /opt/groimp/patches/JOCLCPP.java \
    && echo 'fd9c39f5d4f5b2d627998be6c6fc7d3be2d14cec4f920c6b182e860d3307ef70  /opt/groimp/patches/JOCLCPP.java' | sha256sum -c - \
    && java /opt/groimp/patches/PatchFlux.java /opt/groimp/patches/JOCLCPP.java \
    && javac --release 21 -d /tmp/flux-patch /opt/groimp/patches/JOCLCPP.java \
    && jar uf /opt/groimp/plugins/GPUFlux/GPUFlux.jar -C /tmp/flux-patch .

FROM base AS worker
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip ocl-icd-opencl-dev clinfo libgl1 libglu1-mesa libxrender1 libxtst6 libxi6 libxext6 libfreetype6 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --from=eclipse-temurin:21-jre-jammy /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:$PATH GROIMP_HOME=/opt/groimp
COPY --from=groimp /opt/groimp /opt/groimp
RUN mkdir -p /etc/OpenCL/vendors \
    && echo 'libnvidia-opencl.so.1' > /etc/OpenCL/vendors/nvidia.icd
COPY backend/ .
CMD ["python", "-m", "autotom.worker"]
