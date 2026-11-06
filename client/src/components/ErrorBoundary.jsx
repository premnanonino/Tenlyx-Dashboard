import { Component } from 'react';

/**
 * Catches render errors (including failed lazy-chunk loads) below it and
 * renders `fallback({ error, componentStack, reset })` instead of a blank
 * screen. Changing `resetKey` (e.g. the pathname) clears the error, so
 * navigating away from a broken screen recovers without a reload.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, componentStack: '' };
    this.reset = () => this.setState({ error: null, componentStack: '' });
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ componentStack: info?.componentStack || '' });
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  render() {
    const { error, componentStack } = this.state;
    if (error) return this.props.fallback({ error, componentStack, reset: this.reset });
    return this.props.children;
  }
}
