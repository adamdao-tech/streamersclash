FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scout_reader ./scout_reader

ENV PYTHONUNBUFFERED=1 CACHE_DIR=/cache DEBUG_DIR=/debug
ENTRYPOINT ["python", "-m", "scout_reader.main"]
CMD ["run"]
