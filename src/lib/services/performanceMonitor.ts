// Performance monitoring service for tracking operation performance
export class PerformanceMonitor {
  private metrics: {
    [category: string]: {
      operations: number;
      totalDuration: number;
      errors: number;
      minDuration: number;
      maxDuration: number;
    };
  } = {};

  private thresholds: {
    [category: string]: {
      maxDuration: number; // in milliseconds
      targetHitRate?: number; // for cache categories
    };
  } = {
    'indexeddb': { maxDuration: 100 },
    'cloud': { maxDuration: 1000 },
    'cache': { maxDuration: 50, targetHitRate: 80 },
    'sync': { maxDuration: 2000 }
  };

  // Start timing an operation
  start(category: string): number {
    return performance.now();
  }

  // End timing an operation and record metrics
  end(category: string, startTime: number, success: boolean = true): void {
    const duration = performance.now() - startTime;

    if (!this.metrics[category]) {
      this.metrics[category] = {
        operations: 0,
        totalDuration: 0,
        errors: 0,
        minDuration: Infinity,
        maxDuration: 0
      };
    }

    const metrics = this.metrics[category];
    metrics.operations++;
    metrics.totalDuration += duration;
    if (!success) {
      metrics.errors++;
    }
    metrics.minDuration = Math.min(metrics.minDuration, duration);
    metrics.maxDuration = Math.max(metrics.maxDuration, duration);

    // Check if duration exceeds threshold
    const threshold = this.thresholds[category]?.maxDuration;
    if (threshold && duration > threshold) {
      console.warn(`Performance warning: ${category} operation took ${duration.toFixed(2)}ms (threshold: ${threshold}ms)`);
    }
  }

  // Record a cache hit or miss
  recordCacheHit(category: string, hit: boolean): void {
    const cacheCategory = `cache_${category}`;
    if (!this.metrics[cacheCategory]) {
      this.metrics[cacheCategory] = {
        operations: 0,
        totalDuration: 0,
        errors: 0,
        minDuration: Infinity,
        maxDuration: 0
      };
    }

    const metrics = this.metrics[cacheCategory];
    metrics.operations++;
    if (hit) {
      // For cache hits, we consider it a "negative duration" to differentiate
      metrics.totalDuration += 1;
    }

    // Check hit rate against target
    if (this.metrics[cacheCategory].operations > 10) { // Only check after enough operations
      const hitRate = this.getCacheHitRate(category);
      const targetHitRate = this.thresholds['cache']?.targetHitRate;
      if (targetHitRate && hitRate < targetHitRate) {
        console.warn(`Cache performance warning: ${category} hit rate is ${hitRate.toFixed(2)}% (target: ${targetHitRate}%)`);
      }
    }
  }

  // Get cache hit rate for a category
  getCacheHitRate(category: string): number {
    const cacheCategory = `cache_${category}`;
    const metrics = this.metrics[cacheCategory];
    if (!metrics || metrics.operations === 0) {
      return 0;
    }
    return (metrics.totalDuration / metrics.operations) * 100;
  }

  // Get summary statistics for a category
  getSummary(category?: string): {
    category: string;
    operations: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    errorRate: number;
    hitRate?: number;
  } | {
    category: string;
    operations: number;
    averageDuration: number;
    minDuration: number;
    maxDuration: number;
    errorRate: number;
    hitRate?: number;
  }[] {
    if (category) {
      const metrics = this.metrics[category];
      if (!metrics) {
        return {
          category,
          operations: 0,
          averageDuration: 0,
          minDuration: 0,
          maxDuration: 0,
          errorRate: 0
        };
      }

      const cacheCategory = category.startsWith('cache_') ? category : `cache_${category}`;
      const cacheMetrics = this.metrics[cacheCategory];

      return {
        category,
        operations: metrics.operations,
        averageDuration: metrics.operations > 0 ? metrics.totalDuration / metrics.operations : 0,
        minDuration: metrics.minDuration === Infinity ? 0 : metrics.minDuration,
        maxDuration: metrics.maxDuration,
        errorRate: metrics.operations > 0 ? metrics.errors / metrics.operations : 0,
        hitRate: cacheMetrics ? this.getCacheHitRate(category) : undefined
      };
    }

    // Return summary for all categories
    return Object.keys(this.metrics).map(cat => {
      const metrics = this.metrics[cat];
      const cacheCategory = cat.startsWith('cache_') ? cat : `cache_${cat}`;
      const cacheMetrics = this.metrics[cacheCategory];

      return {
        category: cat,
        operations: metrics.operations,
        averageDuration: metrics.operations > 0 ? metrics.totalDuration / metrics.operations : 0,
        minDuration: metrics.minDuration === Infinity ? 0 : metrics.minDuration,
        maxDuration: metrics.maxDuration,
        errorRate: metrics.operations > 0 ? metrics.errors / metrics.operations : 0,
        hitRate: cacheMetrics ? this.getCacheHitRate(cat.replace('cache_', '')) : undefined
      };
    });
  }

  // Reset metrics for a category or all categories
  reset(category?: string): void {
    if (category) {
      delete this.metrics[category];
      // Also delete cache category if it exists
      const cacheCategory = category.startsWith('cache_') ? category : `cache_${category}`;
      delete this.metrics[cacheCategory];
    } else {
      this.metrics = {};
    }
  }

  // Export metrics for external analysis
  export(): string {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      metrics: this.metrics,
      thresholds: this.thresholds
    }, null, 2);
  }

  // Set custom threshold for a category
  setThreshold(category: string, maxDuration: number, targetHitRate?: number): void {
    this.thresholds[category] = { maxDuration, targetHitRate };
  }
}

// Export singleton instance
export const performanceMonitor = new PerformanceMonitor();
