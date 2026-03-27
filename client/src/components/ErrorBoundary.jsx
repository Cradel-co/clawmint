import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '20px', textAlign: 'center', color: '#e74c3c',
          background: '#1a1a1a', borderRadius: '8px', margin: '10px',
        }}>
          <p style={{ marginBottom: '10px' }}>Algo salió mal en este panel.</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              padding: '6px 16px', background: '#333', color: '#fff',
              border: '1px solid #555', borderRadius: '4px', cursor: 'pointer',
            }}
          >
            Reintentar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
