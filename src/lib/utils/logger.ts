/**
 * Simple logging utility for the application
 */

// Define log levels
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Define log entry structure
interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  meta?: Record<string, any>;
}

/**
 * Logger class for application logging
 */
class Logger {
  private logLevel: LogLevel;

  constructor(logLevel: LogLevel = 'info') {
    this.logLevel = logLevel;
  }

  /**
   * Log a debug message
   * @param message - The message to log
   * @param meta - Additional metadata
   */
  debug(message: string, meta?: Record<string, any>) {
    this.log('debug', message, meta);
  }

  /**
   * Log an info message
   * @param message - The message to log
   * @param meta - Additional metadata
   */
  info(message: string, meta?: Record<string, any>) {
    this.log('info', message, meta);
  }

  /**
   * Log a warning message
   * @param message - The message to log
   * @param meta - Additional metadata
   */
  warn(message: string, meta?: Record<string, any>) {
    this.log('warn', message, meta);
  }

  /**
   * Log an error message
   * @param message - The message to log
   * @param meta - Additional metadata
   */
  error(message: string, meta?: Record<string, any>) {
    this.log('error', message, meta);
  }

  /**
   * Log a message with the specified level
   * @param level - The log level
   * @param message - The message to log
   * @param meta - Additional metadata
   */
  private log(level: LogLevel, message: string, meta?: Record<string, any>) {
    // Check if we should log this level
    if (!this.shouldLog(level)) {
      return;
    }

    // Create log entry
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      meta
    };

    // Format and output log entry
    const formattedEntry = this.formatLogEntry(entry);
    console.log(formattedEntry);

    // In a production environment, you might want to send logs to a external service
    // For now, we'll just log to the console
  }

  /**
   * Format a log entry for output
   * @param entry - The log entry to format
   * @returns The formatted log entry
   */
  private formatLogEntry(entry: LogEntry): string {
    const timestamp = entry.timestamp.toISOString();
    const level = entry.level.toUpperCase().padEnd(7);
    const message = entry.message;

    let formatted = `[${timestamp}] ${level} ${message}`;

    if (entry.meta) {
      formatted += ` ${JSON.stringify(entry.meta)}`;
    }

    return formatted;
  }

  /**
   * Determine if a log level should be logged based on the current log level
   * @param level - The log level to check
   * @returns True if the level should be logged, false otherwise
   */
  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const levelIndex = levels.indexOf(level);

    return levelIndex >= currentLevelIndex;
  }
}

// Create and export a default logger instance
const logger = new Logger(process.env.NODE_ENV === 'development' ? 'debug' : 'info');

export default logger;
export { Logger, type LogLevel, type LogEntry };
