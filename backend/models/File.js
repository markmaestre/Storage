const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  originalName: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['document', 'image', 'video', 'audio', 'pdf', 'spreadsheet', 'presentation', 'archive', 'text', 'code', 'folder']
  },
  size: {
    type: Number,
    required: true,
    default: 0
  },
  path: {
    type: String,
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  parentFolder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    default: null
  },
  isFolder: {
    type: Boolean,
    default: false
  },
  sharedWith: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    permission: {
      type: String,
      enum: ['view', 'edit'],
      default: 'view'
    },
    sharedAt: {
      type: Date,
      default: Date.now
    }
  }],
  isPublic: {
    type: Boolean,
    default: false
  },
  publicUrl: {
    type: String
  },
  inTrash: {
    type: Boolean,
    default: false
  },
  deletedAt: {
    type: Date
  },
  permanentDeleteAt: {
    type: Date
  },
  version: {
    type: Number,
    default: 1
  },
  tags: [String],
  metadata: {
    type: Map,
    of: String
  }
}, {
  timestamps: true
});

// Index for better query performance
fileSchema.index({ userId: 1, parentFolder: 1 });
fileSchema.index({ userId: 1, inTrash: 1 });
fileSchema.index({ 'sharedWith.user': 1 });
fileSchema.index({ permanentDeleteAt: 1 }, { expireAfterSeconds: 0 });

// Virtual for file URL
fileSchema.virtual('url').get(function() {
  return `/api/files/${this._id}/download`;
});

// Method to check if file is shared with user
fileSchema.methods.isSharedWith = function(userId) {
  return this.sharedWith.some(share => share.user.toString() === userId.toString());
};

// Method to get share permissions for user
fileSchema.methods.getUserPermissions = function(userId) {
  const share = this.sharedWith.find(share => share.user.toString() === userId.toString());
  return share ? share.permission : null;
};

module.exports = mongoose.models.File || mongoose.model('File', fileSchema);