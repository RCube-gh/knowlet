FROM python:3.11-slim

# Set environment variables
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

# Ensure upload directory exists
RUN mkdir -p /app/static/uploads

# Expose the API port
EXPOSE 48291

# Start the application
CMD ["python", "main.py"]
