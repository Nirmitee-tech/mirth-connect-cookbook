FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir requests urllib3
COPY mirth_exporter.py /app/mirth_exporter.py
EXPOSE 9100
CMD ["python3", "/app/mirth_exporter.py"]
