# syntax=docker/dockerfile:1
FROM python:3.12-slim

# git: the integration is installed straight from the repo, not PyPI.
# ca-certificates: the harness talks to the model over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# /data is the Render disk: the agent's workspace and its saved trajectories.
# Declared so the image still runs without one mounted.
RUN mkdir -p /data/ws /data/save
ENV AGENT_WORKSPACE=/data/ws \
    AGENT_SAVE_DIR=/data/save \
    PYTHONUNBUFFERED=1

EXPOSE 8027
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8027"]
