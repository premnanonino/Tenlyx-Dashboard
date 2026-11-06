import { Component } from 'react';

/**
 * Catches render errors (including failed lazy-chunk loads) below it and
 * renders `fallback({ error, reset })` instead of a blank screen. The error
 * is only used to pick which page to show; its details are never displayed.
 * Changing `resetKey` (e.g. the pathname) clears the error, so navigating
 * away from a broken screen recovers without a reload.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.reset = () => this.setState({ error: null });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  render() {
    const { error } = this.state;
    if (error) return this.props.fallback({ error, reset: this.reset });
    return this.props.children;
  }
}
