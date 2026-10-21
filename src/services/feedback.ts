/**
 * Feedback Service
 * Handles feedback submission API calls
 */

import { api } from './api';

export interface FeedbackSubmission {
  rating: number;
  comment?: string;
  requestId?: string | number;
  responderAddress?: string;
  requesterAddress?: string;
  metadata?: Record<string, any>;
}

export interface FeedbackResponse {
  success: boolean;
  message?: string;
  feedbackId?: string;
  timestamp?: number;
}

class FeedbackService {
  /**
   * Submit feedback
   */
  async submitFeedback(feedback: FeedbackSubmission): Promise<FeedbackResponse> {
    try {
      const response = await api.post<FeedbackResponse>(
        '/api/feedback',
        feedback
      );
      
      return response.data;
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      
      // Return error response
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to submit feedback',
      };
    }
  }

  /**
   * Submit rating-only feedback (simplified interface)
   */
  async submitRating(rating: number, metadata?: Record<string, any>): Promise<boolean> {
    if (rating < 1 || rating > 5) {
      console.error('Rating must be between 1 and 5');
      return false;
    }

    try {
      const response = await this.submitFeedback({
        rating,
        metadata,
      });
      
      return response.success;
    } catch (error) {
      console.error('Failed to submit rating:', error);
      return false;
    }
  }

  /**
   * Submit feedback with comment
   */
  async submitFeedbackWithComment(
    rating: number,
    comment: string,
    metadata?: Record<string, any>
  ): Promise<boolean> {
    if (rating < 1 || rating > 5) {
      console.error('Rating must be between 1 and 5');
      return false;
    }

    try {
      const response = await this.submitFeedback({
        rating,
        comment: comment.trim(),
        metadata,
      });
      
      return response.success;
    } catch (error) {
      console.error('Failed to submit feedback with comment:', error);
      return false;
    }
  }

  /**
   * Validate feedback before submission
   */
  validateFeedback(feedback: FeedbackSubmission): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (feedback.rating < 1 || feedback.rating > 5) {
      errors.push('Rating must be between 1 and 5');
    }

    if (feedback.comment && feedback.comment.length > 500) {
      errors.push('Comment must be 500 characters or less');
    }

    if (feedback.comment && !feedback.comment.trim()) {
      errors.push('Comment cannot be empty or whitespace only');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Export singleton instance
export const feedbackService = new FeedbackService();

export default FeedbackService;